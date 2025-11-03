// src/routes/carTypes.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

// ✅ Enable authentication if desired
router.use(requireAuth);

/* ========================================
   1️⃣ GET ALL CAR TYPES
======================================== */
router.get("/", async (_req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, label, description, sort_order, created_at, updated_at
      FROM car_types
      ORDER BY sort_order ASC, label ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching car types:", err);
    res.status(500).json({ error: "Failed to fetch car types." });
  }
});

/* ========================================
   2️⃣ CREATE CAR TYPE (Admin/Manager)
======================================== */
router.post("/", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { label, description = "", sort_order = 0 } = req.body;

  if (!label) return res.status(400).json({ error: "Label is required." });

  try {
    const { rows } = await query(
      `
      INSERT INTO car_types (label, description, sort_order, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING *
      `,
      [label, description, sort_order]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("❌ Error creating car type:", err);
    res.status(500).json({ error: "Failed to create car type." });
  }
});

/* ========================================
   3️⃣ UPDATE CAR TYPE (Admin/Manager)
======================================== */
router.put("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  const { label, description, sort_order } = req.body;

  try {
    const { rows } = await query(
      `
      UPDATE car_types
      SET 
        label = COALESCE($1, label),
        description = COALESCE($2, description),
        sort_order = COALESCE($3, sort_order),
        updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [label, description, sort_order, id]
    );

    if (!rows[0]) return res.status(404).json({ error: "Car type not found." });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error updating car type:", err);
    res.status(500).json({ error: "Failed to update car type." });
  }
});

/* ========================================
   4️⃣ DELETE CAR TYPE (Admin/Manager)
======================================== */
router.delete("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;

  try {
    const { rowCount } = await query("DELETE FROM car_types WHERE id = $1", [id]);
    if (rowCount === 0)
      return res.status(404).json({ error: "Car type not found." });

    res.json({ success: true, message: "Car type deleted successfully." });
  } catch (err) {
    console.error("❌ Error deleting car type:", err);
    res.status(500).json({ error: "Failed to delete car type." });
  }
});

export default router;
