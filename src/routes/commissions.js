// backend/src/routes/commissions.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

/* ==========================================
   Helper: date filter for summary
========================================== */
function dateFilter(period = "today") {
  switch (period) {
    case "week":
      return "AND w.washed_at >= NOW() - INTERVAL '7 days'";
    case "month":
      return "AND w.washed_at >= NOW() - INTERVAL '30 days'";
    default:
      return "AND DATE(w.washed_at) = CURRENT_DATE";
  }
}

/* ==========================================
   Commission Summary (used by Staff page)
   GET /commissions/summary?period=today|week|month
========================================== */
router.get("/summary", async (req, res) => {
  const { period = "today" } = req.query;

  try {
    const { rows } = await query(
      `
      SELECT 
        s.id,
        s.name,
        s.role_label,
        COUNT(w.id) AS washes,
        COALESCE(SUM(w.unit_price), 0) AS revenue,
        ROUND(
          COALESCE(SUM(w.unit_price * COALESCE(cr.percentage, 30) / 100), 0),
          2
        ) AS commission
      FROM staff s
      LEFT JOIN washes w 
        ON w.staff_id = s.id
        ${dateFilter(period)}
      LEFT JOIN commission_rates cr
        ON cr.role = s.role_label
      GROUP BY s.id, s.name, s.role_label
      ORDER BY s.name
      `
    );

    const totalRevenue = rows.reduce((a, b) => a + Number(b.revenue), 0);
    const totalCommission = rows.reduce((a, b) => a + Number(b.commission), 0);
    const totalWashes = rows.reduce((a, b) => a + Number(b.washes), 0);
    const businessProfit = totalRevenue - totalCommission;

    const commissionPercent = totalRevenue
      ? ((totalCommission / totalRevenue) * 100).toFixed(1)
      : 0;
    const profitPercent = totalRevenue
      ? ((businessProfit / totalRevenue) * 100).toFixed(1)
      : 0;

    res.json({
      staff: rows,
      totalWashes,
      totalRevenue,
      totalCommission,
      businessProfit,
      commissionPercent,
      profitPercent,
    });
  } catch (err) {
    console.error("❌ Error computing commissions:", err);
    res.status(500).json({ error: "Failed to compute commission summary." });
  }
});

/* ==========================================
   GET all commission rates
========================================== */
router.get("/", async (_req, res) => {
  try {
    const { rows } = await query(
      `
      SELECT id, role, percentage, created_at, updated_at
      FROM commission_rates
      ORDER BY role ASC
      `
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Error loading commission rates:", err);
    res.status(500).json({ error: "Failed to load commission rates." });
  }
});

/* ==========================================
   UPDATE a commission rate
========================================== */
router.put("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  const { percentage } = req.body;

  try {
    const { rows } = await query(
      `
      UPDATE commission_rates
      SET percentage = COALESCE($1, percentage),
          updated_at = NOW()
      WHERE id = $2::uuid
      RETURNING *
      `,
      [percentage, id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Commission rate not found." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error updating commission rate:", err);
    res.status(500).json({ error: "Failed to update commission rate." });
  }
});

/* ==========================================
   CREATE new commission rate
========================================== */
router.post("/", requireRole("ADMIN"), async (req, res) => {
  const { role, percentage } = req.body;

  try {
    const { rows } = await query(
      `
      INSERT INTO commission_rates (id, role, percentage, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
      RETURNING *
      `,
      [role, percentage]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("❌ Error creating commission rate:", err);
    res.status(500).json({ error: "Failed to create commission rate." });
  }
});

/* ==========================================
   DELETE commission rate
========================================== */
router.delete("/:id", requireRole("ADMIN"), async (req, res) => {
  const { id } = req.params;

  try {
    const { rowCount } = await query(
      "DELETE FROM commission_rates WHERE id = $1::uuid",
      [id]
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Commission rate not found." });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error deleting commission rate:", err);
    res.status(500).json({ error: "Failed to delete commission rate." });
  }
});

export default router;
