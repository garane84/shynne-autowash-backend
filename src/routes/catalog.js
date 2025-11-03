// src/routes/catalog.js
import { Router } from "express";
import { query } from "../db.js";
// import { requireAuth } from "../middleware/auth.js"; // Uncomment if auth is active

const router = Router();

// router.use(requireAuth); // Keep disabled while testing

/**
 * GET /catalog
 * Returns services, car_types, and their pricing relationships.
 */
router.get("/", async (_req, res) => {
  try {
    // ✅ Fetch all services (only existing columns)
    const servicesRes = await query(`
      SELECT id, name, base_price, is_active, created_at, updated_at
      FROM services
      ORDER BY name ASC
    `);

    // ✅ Fetch all car types (only existing columns)
    const carTypesRes = await query(`
      SELECT id, label, sort_order
      FROM car_types
      ORDER BY sort_order ASC, label ASC
    `);

    // ✅ Fetch all service prices
    const pricesRes = await query(`
      SELECT service_id, car_type_id, price
      FROM service_prices
    `);

    // ✅ Combine services with their prices
    const services = servicesRes.rows.map((s) => ({
      ...s,
      prices: pricesRes.rows.filter((p) => p.service_id === s.id),
    }));

    res.json({
      services,
      car_types: carTypesRes.rows,
    });
  } catch (err) {
    console.error("❌ GET /catalog failed:", err);
    res.status(500).json({ error: "Failed to load catalog data." });
  }
});

export default router;
