// backend/src/routes/freeWashDraw.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

/** -------- Helpers -------- */
function isoDay(s) {
  // Expect YYYY-MM-DD; fallback to today
  const d = (s || "").toString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? d
    : new Date().toISOString().slice(0, 10);
}
function monthYYYYMM(s) {
  const m = (s || "").toString().slice(0, 7);
  return /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);
}
function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Build WHERE fragment for "Full Wash" filtering */
function buildServiceFilter({ service_id_full, service_name_full }) {
  if (service_id_full) {
    return { sql: "AND w.service_id = $2::uuid", params: [service_id_full] };
  }
  if (service_name_full) {
    // Frontend sends a plain keyword; we wrap with %...%
    return { sql: "AND s.name ILIKE $2", params: [`%${service_name_full}%`] };
  }
  // Default heuristic
  return {
    sql: "AND (s.name ILIKE '%full%' OR s.name ILIKE '%complete%')",
    params: [],
  };
}

/** Query candidates for a given month (derived from date) */
async function fetchCandidates({
  date,
  min_washes = 12,
  limit = 50,
  service_id_full,
  service_name_full,
}) {
  const drawDate = isoDay(date);
  const month = monthYYYYMM(drawDate);
  const minW = toInt(min_washes, 12);
  const lim = Math.max(1, Math.min(toInt(limit, 50), 200));

  const svc = buildServiceFilter({ service_id_full, service_name_full });

  const { rows } = await query(
    `
    WITH month_bounds AS (
      SELECT to_date($1, 'YYYY-MM') AS month_start
    ),
    base AS (
      SELECT
        w.customer_id,
        COALESCE(UPPER(TRIM(w.vehicle_reg)), UPPER(TRIM(c.vehicle_reg))) AS vehicle_reg,
        COALESCE(c.phone, NULL) AS customer_phone,
        COALESCE(c.name,  NULL) AS customer_name,
        w.washed_at
      FROM washes w
      JOIN month_bounds mb
        ON date_trunc('month', w.washed_at) = date_trunc('month', mb.month_start)
      LEFT JOIN customers c ON c.id = w.customer_id
      JOIN services s ON s.id = w.service_id
      WHERE true
        ${svc.sql}
    ),
    agg AS (
      SELECT
        customer_id,
        MAX(vehicle_reg)     AS vehicle_reg,
        MAX(customer_phone)  AS customer_phone,
        MAX(customer_name)   AS customer_name,
        COUNT(*)::int        AS wash_count,
        MAX(washed_at)       AS last_wash
      FROM base
      GROUP BY customer_id
    )
    SELECT a.*
    FROM agg a
    WHERE a.wash_count >= $${2 + svc.params.length}
    ORDER BY a.wash_count DESC, a.last_wash DESC
    LIMIT $${3 + svc.params.length}
    `,
    [month, ...svc.params, minW, lim]
  );

  return rows;
}

/** Ensure a draw day is free (no winner yet) */
async function assertDayFree(drawDate) {
  const existed = await query(
    `SELECT id FROM daily_free_winners WHERE draw_date = $1::date LIMIT 1`,
    [drawDate]
  );
  if (existed.rows[0]) {
    const err = new Error("A winner already exists for that date.");
    err.status = 409;
    throw err;
  }
}

/** Insert winner row for a day */
async function insertWinner({ drawDate, winner, userId }) {
  const ins = await query(
    `
    INSERT INTO daily_free_winners
      (draw_date, customer_id, vehicle_reg, customer_phone, customer_name, created_by)
    VALUES
      ($1::date, $2::uuid, $3, $4, $5, $6::uuid)
    RETURNING *
    `,
    [
      drawDate,
      winner.customer_id || null,
      winner.vehicle_reg || null,
      winner.customer_phone || null,
      winner.customer_name || null,
      userId || null,
    ]
  );
  return ins.rows[0];
}

/** -------- Existing: get the winner (if any) for a date --------
 * GET /?date=YYYY-MM-DD
 */
router.get("/", async (req, res) => {
  try {
    const day = isoDay(req.query.date);
    const { rows } = await query(
      `
      SELECT id, draw_date, customer_id, vehicle_reg, customer_phone, customer_name,
             used_at, created_by, created_at
      FROM daily_free_winners
      WHERE draw_date = $1::date
      LIMIT 1
      `,
      [day]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error("❌ GET (winner) failed:", e);
    res.status(500).json({ error: "Failed to fetch daily free-wash winner." });
  }
});

/** -------- NEW: list eligible candidates (no DB writes) --------
 * GET /eligibles?date=YYYY-MM-DD&min_washes=12&service_name_full=full&limit=50
 * (Alias: /candidates for backward-compat)
 */
async function eligiblesHandler(req, res) {
  try {
    const date = isoDay(req.query.date);
    const min_washes = req.query.min_washes ?? 12;
    const service_name_full =
      req.query.service_name_full || req.query.service_name || null;
    const service_id_full = req.query.service_id_full || null;
    const limit = req.query.limit ?? 50;

    const candidates = await fetchCandidates({
      date,
      min_washes,
      limit,
      service_id_full,
      service_name_full,
    });

    res.json(candidates);
  } catch (e) {
    console.error("❌ GET /eligibles failed:", e);
    res.status(500).json({ error: "Failed to fetch eligible candidates." });
  }
}
router.get("/eligibles", requireRole("ADMIN", "MANAGER"), eligiblesHandler);
router.get("/candidates", requireRole("ADMIN", "MANAGER"), eligiblesHandler); // alias

/** -------- UPDATED: draw suggestion (NO auto-insert by default) --------
 * POST /draw
 * Body: { date, min_washes?, service_id_full?, service_name_full?, autoApprove? }
 * If autoApprove === true, creates the winner row (legacy behavior).
 * Otherwise returns { candidate, notice } and expects /approve afterward.
 */
router.post("/draw", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try {
    const drawDate = isoDay(req.body?.date);
    const min_washes = req.body?.min_washes ?? 12;
    const service_id_full = req.body?.service_id_full || null;
    const service_name_full = req.body?.service_name_full || null;
    const autoApprove = Boolean(req.body?.autoApprove);

    // Idempotent: if a winner already exists, return it
    const existed = await query(
      `SELECT * FROM daily_free_winners WHERE draw_date = $1::date LIMIT 1`,
      [drawDate]
    );
    if (existed.rows[0]) return res.json(existed.rows[0]);

    const candidates = await fetchCandidates({
      date: drawDate,
      min_washes,
      limit: 200,
      service_id_full,
      service_name_full,
    });

    if (candidates.length === 0) {
      return res
        .status(404)
        .json({ error: "No eligible customers for that date/month." });
    }

    const candidate =
      candidates[Math.floor(Math.random() * candidates.length)];

    if (!autoApprove) {
      return res.json({
        candidate,
        notice:
          "Candidate suggested. Call POST /approve to confirm the winner for this date.",
      });
    }

    await assertDayFree(drawDate);
    const created = await insertWinner({
      drawDate,
      winner: candidate,
      userId: req.user?.sub,
    });
    res.status(201).json(created);
  } catch (e) {
    console.error("❌ POST /draw failed:", e);
    res
      .status(e.status || 500)
      .json({ error: e.message || "Failed to run daily free-wash draw." });
  }
});

/** -------- NEW: approve a specific candidate for the day --------
 * POST /approve
 * Body: { date, customer_id?, vehicle_reg?, customer_phone?, customer_name? }
 * - Exactly one winner per day (409 if already chosen)
 */
router.post("/approve", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try {
    const drawDate = isoDay(req.body?.date);
    const winner = {
      customer_id: req.body?.customer_id || null,
      vehicle_reg: (req.body?.vehicle_reg || "").toUpperCase().trim() || null,
      customer_phone: req.body?.customer_phone || null,
      customer_name: req.body?.customer_name || null,
    };

    await assertDayFree(drawDate);
    const created = await insertWinner({
      drawDate,
      winner,
      userId: req.user?.sub,
    });
    res.status(201).json(created);
  } catch (e) {
    console.error("❌ POST /approve failed:", e);
    res
      .status(e.status || 500)
      .json({ error: e.message || "Failed to approve winner for the date." });
  }
});

/** -------- NEW: schedule another eligible to a different date --------
 * POST /reschedule
 * Body: { to_date, customer_id?, vehicle_reg?, customer_phone?, customer_name? }
 * - Creates a winner row on a *different* day (must be free)
 * - Useful when two are eligible on the same day and you want to pick one
 *   and move the other to another day.
 * (Alias: POST /move to keep earlier references working)
 */
async function rescheduleHandler(req, res) {
  try {
    const toDate = isoDay(req.body?.to_date);
    if (!toDate) return res.status(400).json({ error: "to_date is required." });

    await assertDayFree(toDate);

    const winner = {
      customer_id: req.body?.customer_id || null,
      vehicle_reg: (req.body?.vehicle_reg || "").toUpperCase().trim() || null,
      customer_phone: req.body?.customer_phone || null,
      customer_name: req.body?.customer_name || null,
    };

    const created = await insertWinner({
      drawDate: toDate,
      winner,
      userId: req.user?.sub,
    });
    res.status(201).json(created);
  } catch (e) {
    console.error("❌ POST /reschedule failed:", e);
    res
      .status(e.status || 500)
      .json({ error: e.message || "Failed to schedule winner to new date." });
  }
}
router.post("/reschedule", requireRole("ADMIN", "MANAGER"), rescheduleHandler);
router.post("/move", requireRole("ADMIN", "MANAGER"), rescheduleHandler); // alias

/** -------- NEW: revoke a saved winner for a date (admin safety) --------
 * DELETE /?date=YYYY-MM-DD
 */
router.delete("/", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try {
    const day = isoDay(req.query.date);
    const del = await query(
      `DELETE FROM daily_free_winners WHERE draw_date = $1::date RETURNING id`,
      [day]
    );
    if (del.rowCount === 0)
      return res.status(404).json({ error: "No winner found for that date." });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ DELETE (revoke) failed:", e);
    res
      .status(500)
      .json({ error: "Failed to revoke the daily free-wash winner." });
  }
});

export default router;
