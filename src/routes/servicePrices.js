// src/routes/servicePrices.js
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/**
 * PUT /services/:serviceId/prices/:carTypeId
 * Body: { price: number }
 * Upserts a price for (service, car type)
 */
router.put('/services/:serviceId/prices/:carTypeId', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { serviceId, carTypeId } = req.params;
  const { price } = req.body;

  if (price == null || isNaN(Number(price))) {
    return res.status(400).json({ error: 'Valid price is required.' });
  }

  try {
    const sql = `
      INSERT INTO service_prices (service_id, car_type_id, price)
      VALUES ($1,$2,$3)
      ON CONFLICT (service_id, car_type_id)
      DO UPDATE SET price = EXCLUDED.price
      RETURNING service_id, car_type_id, price
    `;
    const { rows } = await query(sql, [serviceId, carTypeId, Number(price)]);
    res.json(rows[0]);
  } catch (e) {
    console.error('Upsert service price failed', e);
    res.status(500).json({ error: 'Failed to save price' });
  }
});

export default router;
