// backend/src/routes/featuredVehicles.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

function normMonth(m) {
  return /^\d{4}-\d{2}$/.test(m || "") ? m.slice(0, 7) : new Date().toISOString().slice(0, 7);
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
    const month = normMonth(req.query.month);
    const { rows } = await query(
      `
      SELECT id, vehicle_reg, month, used_at, created_by, created_at
      FROM featured_vehicles
      WHERE month = $1
      ORDER BY created_at DESC
      `,
      [month]
    );
    res.json(rows);
  } catch (e) {
    console.error("❌ GET /featured-vehicles failed:", e);
    res.status(500).json({ error: "Failed to load featured vehicles." });
  }
});

/**
 * POST /featured-vehicles
 * Body: { vehicle_reg, month }
 * Creates (or no-ops) a featured vehicle for the month; only ADMIN/MANAGER.
 */
router.post("/", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  try {
    const vehicle_reg = normReg(req.body?.vehicle_reg);
    const month = normMonth(req.body?.month);

    if (!vehicle_reg) {
      return res.status(400).json({ error: "vehicle_reg is required" });
    }

    const { rows } = await query(
      `
      INSERT INTO featured_vehicles (vehicle_reg, month, created_by)
      VALUES ($1, $2, $3::uuid)
      ON CONFLICT (upper(trim(vehicle_reg)), month) DO NOTHING
      RETURNING id, vehicle_reg, month, used_at, created_by, created_at
      `,
      [vehicle_reg, month, req.user?.sub || null]
    );

    // If it already existed (conflict), fetch it so the client still gets a row
    if (rows.length === 0) {
      const { rows: existed } = await query(
        `
        SELECT id, vehicle_reg, month, used_at, created_by, created_at
        FROM featured_vehicles
        WHERE upper(trim(vehicle_reg)) = upper(trim($1)) AND month = $2
        `,
        [vehicle_reg, month]
      );
      return res.status(200).json(existed[0]);
    }

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("❌ POST /featured-vehicles failed:", e);
    res.status(500).json({ error: "Failed to feature vehicle." });
  }
});

export default router;
