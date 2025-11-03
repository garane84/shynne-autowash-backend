// src/routes/services.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

// ✅ Enable auth middleware if desired
router.use(requireAuth);

/* ========================================
   1️⃣ GET all services + prices by car type
======================================== */
router.get("/", async (_req, res) => {
  try {
    const { rows: services } = await query(
      "SELECT id, name, description, base_price, created_at, updated_at FROM services ORDER BY name"
    );
    const { rows: carTypes } = await query(
      "SELECT id, label, description, sort_order FROM car_types ORDER BY sort_order"
    );
    const { rows: prices } = await query(
      "SELECT service_id, car_type_id, price FROM service_prices"
    );

    const data = services.map((s) => ({
      ...s,
      prices: carTypes.map((ct) => {
        const match = prices.find(
          (p) => p.service_id === s.id && p.car_type_id === ct.id
        );
        return {
          car_type_id: ct.id,
          car_type_label: ct.label,
          price: match ? Number(match.price) : 0,
        };
      }),
    }));

    res.json({ car_types: carTypes, services: data });
  } catch (err) {
    console.error("❌ Error listing services:", err);
    res.status(500).json({ error: "Failed to fetch services." });
  }
});

/* ========================================
   2️⃣ CREATE new service
======================================== */
router.post("/", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { name, description, base_price } = req.body;

  try {
    const result = await query(
      `
      INSERT INTO services (name, description, base_price, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING *
      `,
      [name, description || "", base_price || 0]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating service:", err);
    res.status(500).json({ error: "Failed to create service." });
  }
});

/* ========================================
   3️⃣ UPDATE service details
======================================== */
router.put("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  const { name, description, base_price } = req.body;

  try {
    const { rows } = await query(
      `
      UPDATE services
      SET 
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        base_price = COALESCE($3, base_price),
        updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [name, description, base_price, id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Service not found." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error updating service:", err);
    res.status(500).json({ error: "Failed to update service." });
  }
});

/* ========================================
   4️⃣ UPDATE price for one car type
======================================== */
router.put("/:serviceId/price/:carTypeId", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { serviceId, carTypeId } = req.params;
  const { price } = req.body;

  try {
    await query(
      `
      INSERT INTO service_prices (service_id, car_type_id, price, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (service_id, car_type_id)
      DO UPDATE SET price = EXCLUDED.price, updated_at = NOW()
      `,
      [serviceId, carTypeId, price]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error updating service price:", err);
    res.status(500).json({ error: "Failed to update price." });
  }
});

/* ========================================
   5️⃣ DELETE service
======================================== */
router.delete("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query("DELETE FROM services WHERE id = $1", [id]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Service not found." });

    res.json({ success: true, message: "Service deleted successfully." });
  } catch (err) {
    console.error("❌ Error deleting service:", err);
    res.status(500).json({ error: "Failed to delete service." });
  }
});

export default router;
