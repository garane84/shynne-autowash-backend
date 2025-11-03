// backend/src/routes/analytics.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

/**
 * GET /analytics/top-vehicles?month=YYYY-MM&limit=5
 * Returns:
 * [{ vehicle_reg, customer_name, customer_phone, washes, last_wash }]
 */
router.get("/top-vehicles", async (req, res) => {
  try {
    const month = (req.query.month || "").toString().slice(0, 7);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "5", 10), 50));

    // default to current month if invalid
    const monthFilter = /^\d{4}-\d{2}$/.test(month)
      ? month
      : new Date().toISOString().slice(0, 7);

    // We use COALESCE to prefer the wash.vehicle_reg column if you add it later;
    // today we fall back to customers.vehicle_reg
    const { rows } = await query(
      `
      WITH base AS (
        SELECT
          UPPER(TRIM(COALESCE(c.vehicle_reg, ''))) AS vehicle_reg,
          c.name  AS customer_name,
          c.phone AS customer_phone,
          w.washed_at
        FROM washes w
        LEFT JOIN customers c ON c.id = w.customer_id
        WHERE date_trunc('month', w.washed_at) = date_trunc('month', to_timestamp($1 || '-01', 'YYYY-MM-DD'))
          AND COALESCE(c.vehicle_reg, '') <> ''
      )
      SELECT
        vehicle_reg,
        MAX(customer_name)   AS customer_name,
        MAX(customer_phone)  AS customer_phone,
        COUNT(*)::int        AS washes,
        MAX(washed_at)       AS last_wash
      FROM base
      GROUP BY vehicle_reg
      ORDER BY washes DESC, last_wash DESC
      LIMIT $2
      `,
      [monthFilter, limit]
    );

    res.json(rows);
  } catch (e) {
    console.error("❌ /analytics/top-vehicles failed:", e);
    res.status(500).json({ error: "Failed to load top vehicles." });
  }
});

export default router;
