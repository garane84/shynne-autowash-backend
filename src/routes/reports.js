import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/daily', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const sqlW = `
    SELECT COUNT(*)::int AS wash_count, COALESCE(SUM(unit_price),0)::numeric AS revenue,
           COALESCE(SUM(commission_amount),0)::numeric AS commission,
           COALESCE(SUM(profit_amount),0)::numeric AS profit
    FROM washes WHERE washed_at >= $1::date AND washed_at < ($1::date + interval '1 day')`;
  const sqlE = `
    SELECT COALESCE(SUM(amount),0)::numeric AS expenses
    FROM expenses WHERE spent_at >= $1::date AND spent_at < ($1::date + interval '1 day')`;
  const [{ rows: [w] }, { rows: [e] }] = await Promise.all([
    query(sqlW, [date]), query(sqlE, [date])
  ]);
  const net = Number(w.profit) - Number(e.expenses);
  res.json({ date, ...w, expenses: e.expenses, net_income: net });
});

router.get('/services', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const sql = `
    SELECT date_trunc('day', w.washed_at) AS day, s.name AS service,
           COUNT(*)::int AS washes_count, SUM(w.unit_price)::numeric AS revenue,
           SUM(w.commission_amount)::numeric AS commission, SUM(w.profit_amount)::numeric AS profit
    FROM washes w JOIN services s ON s.id=w.service_id
    WHERE w.washed_at >= $1::date AND w.washed_at < ($1::date + interval '1 day')
    GROUP BY 1,2 ORDER BY 2`;
  const { rows } = await query(sql, [date]);
  res.json(rows);
});

router.get('/staff', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const sql = `
    SELECT st.name AS staff_name, COUNT(*)::int AS washes_count, SUM(w.commission_amount)::numeric AS commission_to_pay
    FROM washes w JOIN staff st ON st.id=w.staff_id
    WHERE w.washed_at >= $1::date AND w.washed_at < ($1::date + interval '1 day')
    GROUP BY 1 ORDER BY 1`;
  const { rows } = await query(sql, [date]);
  res.json(rows);
});

export default router;
