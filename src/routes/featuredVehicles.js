// backend/src/routes/featuredVehicles.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

function normMonth(m) {
  return /^\d{4}-\d{2}$/.test(m || "")
    ? m.slice(0, 7)
    : new Date().toISOString().slice(0, 7);
}
function normReg(reg) {
  return (reg || "").toString().trim().toUpperCase();
}

/**
 * GET /featured-vehicles?month=YYYY-MM
 * Returns: [{ id, vehicle_reg, month, used_at, created_by, created_at }]
 */
router.get("/", async (req, res) => {
  try {
    const raw = normMonth(req.query.month);
    // use SQL to coerce to YYYY-MM-01 (date)
    const sql = `
      WITH m AS (
        SELECT COALESCE(
                 to_date($1, 'YYYY-MM'),
                 date_trunc('month', now())::date
               ) AS month_start
      )
      SELECT
        fv.id,
        upper(trim(fv.vehicle_reg)) AS vehicle_reg,
        fv.month,
        fv.used_at,
        fv.featured_by            AS created_by,   -- alias to satisfy client
        fv.created_at
      FROM featured_vehicles fv
      JOIN m ON fv.month = m.month_start
      ORDER BY fv.created_at DESC;
    `;
    const { rows } = await query(sql, [raw || null]);
    res.json(rows ?? []);
  } catch (e) {
    console.error("❌ GET /featured-vehicles failed:", e);
    res.status(500).json({ error: "Failed to load featured vehicles." });
  }
});

/**
 * POST /featured-vehicles
 * Body: { vehicle_reg, month }  (month = YYYY-MM)
 * Creates or returns existing row; only ADMIN/MANAGER.
 */
router.post("/", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try {
    const vehicle_reg = normReg(req.body?.vehicle_reg);
    const rawMonth = normMonth(req.body?.month);
    if (!vehicle_reg) {
      return res.status(400).json({ error: "vehicle_reg is required" });
    }

    // Insert; if already exists, do nothing, then fetch existing row
    const insertSql = `
      WITH m AS (
        SELECT COALESCE(
                 to_date($1, 'YYYY-MM'),
                 date_trunc('month', now())::date
               ) AS month_start
      )
      INSERT INTO featured_vehicles (vehicle_reg, month, featured_by)
      SELECT $2, m.month_start, $3::uuid
      FROM m
      ON CONFLICT (vehicle_reg, month) DO NOTHING
      RETURNING id, vehicle_reg, month, used_at, featured_by AS created_by, created_at;
    `;
    const userId = req.user?.sub || null;
    const ins = await query(insertSql, [rawMonth, vehicle_reg, userId]);

    if (ins.rows.length > 0) {
      return res.status(201).json(ins.rows[0]);
    }

    // Fetch existing row (if conflict happened)
    const fetchSql = `
      WITH m AS (
        SELECT COALESCE(
                 to_date($1, 'YYYY-MM'),
                 date_trunc('month', now())::date
               ) AS month_start
      )
      SELECT id, vehicle_reg, month, used_at, featured_by AS created_by, created_at
      FROM featured_vehicles fv
      JOIN m ON fv.month = m.month_start
      WHERE upper(trim(fv.vehicle_reg)) = upper(trim($2))
      LIMIT 1;
    `;
    const existed = await query(fetchSql, [rawMonth, vehicle_reg]);
    return res.status(200).json(existed.rows[0] || null);
  } catch (e) {
    console.error("❌ POST /featured-vehicles failed:", e);
    res.status(500).json({ error: "Failed to feature vehicle." });
  }
});

export default router;
