-- ============================================================
-- Daily Free-Wash: Approval Workflow
-- - Adds status/approval to daily_free_winners
-- - Introduces daily_free_candidates (multiple per day)
-- - Helper functions to approve and reschedule candidates
-- ============================================================

-- 1) Status enum for winners (safe-create)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'daily_free_status' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE daily_free_status AS ENUM ('PENDING','APPROVED','REVOKED');
  END IF;
END$$;

-- 2) Extend winners table with approval metadata
ALTER TABLE daily_free_winners
  ADD COLUMN IF NOT EXISTS status daily_free_status NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS note TEXT;

-- Backfill existing historical rows as APPROVED
UPDATE daily_free_winners
SET status = 'APPROVED',
    approved_at = COALESCE(approved_at, created_at)
WHERE status IS DISTINCT FROM 'APPROVED';

-- 3) Candidate pool (many per date; you approve exactly one)
CREATE TABLE IF NOT EXISTS daily_free_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_date DATE NOT NULL,                       -- proposed/eligible date
  customer_id UUID REFERENCES customers(id),
  vehicle_reg TEXT,
  customer_phone TEXT,
  customer_name TEXT,
  washes_in_month INT,                           -- optional: useful metadata
  last_wash TIMESTAMPTZ,                         -- optional: tie-break context
  eligible_reason TEXT,                          -- e.g., '>=12 Full Washes'
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draw_date, customer_id, vehicle_reg)   -- dedupe same candidate for the day
);

CREATE INDEX IF NOT EXISTS idx_daily_free_candidates_date
  ON daily_free_candidates(draw_date);

-- 4) Helpful view: candidates with winner flag
CREATE OR REPLACE VIEW vw_daily_free_candidates AS
SELECT
  c.*,
  w.id AS winner_id,
  (w.draw_date IS NOT NULL) AS is_approved_winner
FROM daily_free_candidates c
LEFT JOIN daily_free_winners w
  ON w.draw_date = c.draw_date
 AND w.customer_id IS NOT DISTINCT FROM c.customer_id
 AND COALESCE(NULLIF(UPPER(w.vehicle_reg),''), '') = COALESCE(NULLIF(UPPER(c.vehicle_reg),''), '');

-- 5) Function: approve a candidate (ensures one winner per date)
-- Usage: SELECT approve_daily_free_candidate('<candidate_uuid>', '<target_date>'::date, '<approver_uuid>', 'optional note');
CREATE OR REPLACE FUNCTION approve_daily_free_candidate(
  p_candidate_id UUID,
  p_draw_date DATE,
  p_approver UUID,
  p_note TEXT DEFAULT NULL
) RETURNS daily_free_winners AS $$
DECLARE
  v_cand daily_free_candidates;
  v_date DATE;
  v_exists UUID;
  v_winner daily_free_winners;
BEGIN
  IF p_candidate_id IS NULL THEN
    RAISE EXCEPTION 'candidate_id is required';
  END IF;

  SELECT * INTO v_cand FROM daily_free_candidates WHERE id = p_candidate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Candidate (%) not found', p_candidate_id;
  END IF;

  v_date := COALESCE(p_draw_date, v_cand.draw_date);

  -- Ensure no approved winner exists for that date
  SELECT id INTO v_exists
  FROM daily_free_winners
  WHERE draw_date = v_date
    AND status = 'APPROVED'
  LIMIT 1;

  IF v_exists IS NOT NULL THEN
    RAISE EXCEPTION 'An approved winner already exists for %', v_date;
  END IF;

  -- Insert winner as APPROVED
  INSERT INTO daily_free_winners (
    draw_date, customer_id, vehicle_reg, customer_phone, customer_name,
    used_at, created_by, created_at, status, approved_by, approved_at, note
  )
  VALUES (
    v_date, v_cand.customer_id, v_cand.vehicle_reg, v_cand.customer_phone, v_cand.customer_name,
    NULL, p_approver, now(), 'APPROVED', p_approver, now(), p_note
  )
  RETURNING * INTO v_winner;

  RETURN v_winner;
END;
$$ LANGUAGE plpgsql;

-- 6) Function: reschedule a candidate to a different date
-- Ensures no duplicate candidate row for the new date for the same person/vehicle
-- Usage: SELECT reschedule_daily_free_candidate('<candidate_uuid>', '<new_date>'::date);
CREATE OR REPLACE FUNCTION reschedule_daily_free_candidate(
  p_candidate_id UUID,
  p_new_date DATE
) RETURNS daily_free_candidates AS $$
DECLARE
  v_cand daily_free_candidates;
  v_dup UUID;
BEGIN
  IF p_candidate_id IS NULL OR p_new_date IS NULL THEN
    RAISE EXCEPTION 'candidate_id and new_date are required';
  END IF;

  SELECT * INTO v_cand FROM daily_free_candidates WHERE id = p_candidate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Candidate (%) not found', p_candidate_id;
  END IF;

  -- Prevent duplicates on the target day for same person/vehicle
  SELECT id INTO v_dup
  FROM daily_free_candidates
  WHERE draw_date = p_new_date
    AND customer_id IS NOT DISTINCT FROM v_cand.customer_id
    AND COALESCE(NULLIF(UPPER(vehicle_reg),''), '') = COALESCE(NULLIF(UPPER(v_cand.vehicle_reg),''), '')
    AND id <> v_cand.id
  LIMIT 1;

  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'This candidate (or same vehicle) already exists for the new date (%)', p_new_date;
  END IF;

  UPDATE daily_free_candidates
  SET draw_date = p_new_date
  WHERE id = p_candidate_id;

  RETURN (SELECT * FROM daily_free_candidates WHERE id = p_candidate_id);
END;
$$ LANGUAGE plpgsql;

-- 7) Function: revoke winner (admin safety)
-- Usage: SELECT revoke_daily_free_winner('<winner_uuid>', '<reason>');
CREATE OR REPLACE FUNCTION revoke_daily_free_winner(
  p_winner_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS daily_free_winners AS $$
DECLARE
  v_row daily_free_winners;
BEGIN
  UPDATE daily_free_winners
  SET status = 'REVOKED',
      note = COALESCE(note,'') || CASE WHEN p_reason IS NOT NULL THEN E'\n[REVOCATION] '||p_reason ELSE '' END
  WHERE id = p_winner_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Winner (%) not found', p_winner_id;
  END IF;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- 8) Guard rails: still exactly ONE approved winner per day
-- (Application logic should enforce; keep unique on draw_date for winners table)
-- If you ever need to allow multiple statuses per day, keep UNIQUE only for APPROVED via partial index:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uniq_daily_free_winners_approved_per_day'
  ) THEN
    CREATE UNIQUE INDEX uniq_daily_free_winners_approved_per_day
      ON daily_free_winners(draw_date)
      WHERE status = 'APPROVED';
  END IF;
END$$;

-- 9) NOTE for backend logic (not SQL):
-- - Award free wash ONLY when an APPROVED winner exists for the wash date.
-- - Do NOT auto-award based on candidates; candidates require explicit approval.
