// src/routes/reports.js
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/* ---------------------------------------------------------
   Helpers: flexible date range
   Supports:
   - ?date=YYYY-MM-DD               (single day)
   - ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive start, exclusive end+1d)
   - ?month=YYYY-MM                 (whole calendar month)
--------------------------------------------------------- */
function resolveRange({ date, from, to, month }) {
  const todayISO = new Date().toISOString().slice(0, 10);

  // month takes precedence
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    return { start, end, label: month };
  }

  // explicit range next
  if (from) {
    const start = new Date(from);
    if (to) {
      const end = new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000);
      return { start, end, label: `${from}..${to}` };
    }
    // only from => single day
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end, label: from };
  }

  // single day (default to today)
  const d = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayISO;
  const start = new Date(d);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, label: d };
}

function toPgTs(d) {
  return d.toISOString(); // ISO for timestamptz in PG
}

/* ---------------------------------------------------------
   DAILY — legacy-compatible (still accepts ?date)
--------------------------------------------------------- */
router.get('/daily', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const sqlW = `
      SELECT COUNT(*)::int AS wash_count,
             COALESCE(SUM(unit_price),0)::numeric        AS revenue,
             COALESCE(SUM(commission_amount),0)::numeric AS commission,
             COALESCE(SUM(profit_amount),0)::numeric     AS profit
      FROM washes
      WHERE washed_at >= $1::date
        AND washed_at <  ($1::date + interval '1 day')
    `;
    const sqlE = `
      SELECT COALESCE(SUM(amount),0)::numeric AS expenses
      FROM expenses
      WHERE spent_at >= $1::date
        AND spent_at <  ($1::date + interval '1 day')
    `;
    const [{ rows: [w] }, { rows: [e] }] = await Promise.all([
      query(sqlW, [date]),
      query(sqlE, [date]),
    ]);
    const net = Number(w.profit) - Number(e.expenses);
    res.json({ date, ...w, expenses: e.expenses, net_income: net });
  } catch (err) {
    console.error('❌ /reports/daily error:', err);
    res.status(500).json({ error: 'Failed to load daily report.' });
  }
});

/* ---------------------------------------------------------
   SUMMARY — totals + daily series for any period
   /reports/summary?date=YYYY-MM-DD
   /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
   /reports/summary?month=YYYY-MM
--------------------------------------------------------- */
router.get('/summary', async (req, res) => {
  try {
    const { start, end, label } = resolveRange(req.query);
    const pStart = toPgTs(start);
    const pEnd   = toPgTs(end);

    const totalsSql = `
      WITH w AS (
        SELECT
          COUNT(*)::int                                  AS wash_count,
          COALESCE(SUM(unit_price),0)::numeric           AS revenue,
          COALESCE(SUM(commission_amount),0)::numeric    AS commission,
          COALESCE(SUM(profit_amount),0)::numeric        AS profit
        FROM washes
        WHERE washed_at >= $1::timestamptz
          AND washed_at <  $2::timestamptz
      ),
      e AS (
        SELECT COALESCE(SUM(amount),0)::numeric AS expenses
        FROM expenses
        WHERE spent_at >= $1::timestamptz
          AND spent_at <  $2::timestamptz
      )
      SELECT w.wash_count, w.revenue, w.commission, w.profit, e.expenses
      FROM w CROSS JOIN e
    `;

    const seriesSql = `
      SELECT
        date_trunc('day', washed_at)::date AS day,
        COUNT(*)::int                        AS wash_count,
        COALESCE(SUM(unit_price),0)::numeric        AS revenue,
        COALESCE(SUM(commission_amount),0)::numeric AS commission,
        COALESCE(SUM(profit_amount),0)::numeric     AS profit
      FROM washes
      WHERE washed_at >= $1::timestamptz
        AND washed_at <  $2::timestamptz
      GROUP BY 1
      ORDER BY 1
    `;

    const expSeriesSql = `
      SELECT
        date_trunc('day', spent_at)::date AS day,
        COALESCE(SUM(amount),0)::numeric AS expenses
      FROM expenses
      WHERE spent_at >= $1::timestamptz
        AND spent_at <  $2::timestamptz
      GROUP BY 1
      ORDER BY 1
    `;

    const [{ rows: [t] }, { rows: ws }, { rows: es }] = await Promise.all([
      query(totalsSql, [pStart, pEnd]),
      query(seriesSql, [pStart, pEnd]),
      query(expSeriesSql, [pStart, pEnd]),
    ]);

    const expenses = Number(t?.expenses || 0);
    const net_income = Number(t?.profit || 0) - expenses;

    // Merge daily expenses into wash series
    const expMap = new Map(es.map(r => [String(r.day), Number(r.expenses || 0)]));
    const daily = ws.map(row => ({
      day: String(row.day),
      wash_count: row.wash_count,
      revenue: Number(row.revenue || 0),
      commission: Number(row.commission || 0),
      profit: Number(row.profit || 0),
      expenses: expMap.get(String(row.day)) || 0,
      net: Number(row.profit || 0) - (expMap.get(String(row.day)) || 0),
    }));

    res.json({
      range: { start: pStart, end: pEnd, label },
      totals: {
        wash_count: t?.wash_count || 0,
        revenue: Number(t?.revenue || 0),
        commission: Number(t?.commission || 0),
        profit: Number(t?.profit || 0),
        expenses,
        net_income,
      },
      daily,
    });
  } catch (err) {
    console.error('❌ /reports/summary error:', err);
    res.status(500).json({ error: 'Failed to load summary report.' });
  }
});

/* ---------------------------------------------------------
   SERVICES — accepts day/range/month (keeps ?date for compat)
--------------------------------------------------------- */
router.get('/services', async (req, res) => {
  try {
    const { start, end } = resolveRange(req.query);
    const pStart = toPgTs(start);
    const pEnd   = toPgTs(end);

    const sql = `
      SELECT
        s.name AS service,
        COUNT(*)::int                                 AS washes_count,
        COALESCE(SUM(w.unit_price),0)::numeric        AS revenue,
        COALESCE(SUM(w.commission_amount),0)::numeric AS commission,
        COALESCE(SUM(w.profit_amount),0)::numeric     AS profit
      FROM washes w
      JOIN services s ON s.id = w.service_id
      WHERE w.washed_at >= $1::timestamptz
        AND w.washed_at <  $2::timestamptz
      GROUP BY 1
      ORDER BY 1
    `;
    const { rows } = await query(sql, [pStart, pEnd]);
    res.json(rows);
  } catch (err) {
    console.error('❌ /reports/services error:', err);
    res.status(500).json({ error: 'Failed to load services report.' });
  }
});

/* ---------------------------------------------------------
   STAFF — accepts day/range/month (keeps ?date for compat)
--------------------------------------------------------- */
router.get('/staff', async (req, res) => {
  try {
    const { start, end } = resolveRange(req.query);
    const pStart = toPgTs(start);
    const pEnd   = toPgTs(end);

    const sql = `
      SELECT
        st.name AS staff_name,
        COUNT(*)::int                                 AS washes_count,
        COALESCE(SUM(w.commission_amount),0)::numeric AS commission_to_pay
      FROM washes w
      JOIN staff st ON st.id = w.staff_id
      WHERE w.staff_id IS NOT NULL
        AND w.washed_at >= $1::timestamptz
        AND w.washed_at <  $2::timestamptz
      GROUP BY 1
      ORDER BY 1
    `;
    const { rows } = await query(sql, [pStart, pEnd]);
    res.json(rows);
  } catch (err) {
    console.error('❌ /reports/staff error:', err);
    res.status(500).json({ error: 'Failed to load staff report.' });
  }
});

/* ---------------------------------------------------------
   EXPENSES — totals + list for day/range/month
--------------------------------------------------------- */
router.get('/expenses', async (req, res) => {
  try {
    const { start, end } = resolveRange(req.query);
    const pStart = toPgTs(start);
    const pEnd   = toPgTs(end);

    const totalSql = `
      SELECT COALESCE(SUM(amount),0)::numeric AS total_expenses
      FROM expenses
      WHERE spent_at >= $1::timestamptz
        AND spent_at <  $2::timestamptz
    `;
    const listSql = `
      SELECT id, description, amount, spent_at, created_at
      FROM expenses
      WHERE spent_at >= $1::timestamptz
        AND spent_at <  $2::timestamptz
      ORDER BY spent_at DESC, created_at DESC
    `;

    const [{ rows: [t] }, { rows: items }] = await Promise.all([
      query(totalSql, [pStart, pEnd]),
      query(listSql, [pStart, pEnd]),
    ]);

    res.json({
      range: { start: pStart, end: pEnd },
      total: Number(t?.total_expenses || 0),
      items,
    });
  } catch (err) {
    console.error('❌ /reports/expenses error:', err);
    res.status(500).json({ error: 'Failed to load expenses report.' });
  }
});

/* ---------------------------------------------------------
   PROFIT & LOSS — totals + daily series for day/range/month
--------------------------------------------------------- */
router.get('/profit-loss', async (req, res) => {
  try {
    const { start, end } = resolveRange(req.query);
    const pStart = toPgTs(start);
    const pEnd   = toPgTs(end);

    const totalsSql = `
      WITH w AS (
        SELECT
          COALESCE(SUM(unit_price),0)::numeric        AS revenue,
          COALESCE(SUM(commission_amount),0)::numeric AS commission,
          COALESCE(SUM(profit_amount),0)::numeric     AS profit
        FROM washes
        WHERE washed_at >= $1::timestamptz
          AND washed_at <  $2::timestamptz
      ),
      e AS (
        SELECT COALESCE(SUM(amount),0)::numeric AS expenses
        FROM expenses
        WHERE spent_at >= $1::timestamptz
          AND spent_at <  $2::timestamptz
      )
      SELECT w.revenue, w.commission, w.profit, e.expenses
      FROM w CROSS JOIN e
    `;

    const seriesSql = `
      WITH ws AS (
        SELECT
          date_trunc('day', washed_at)::date AS day,
          COALESCE(SUM(unit_price),0)::numeric        AS revenue,
          COALESCE(SUM(commission_amount),0)::numeric AS commission,
          COALESCE(SUM(profit_amount),0)::numeric     AS profit
        FROM washes
        WHERE washed_at >= $1::timestamptz
          AND washed_at <  $2::timestamptz
        GROUP BY 1
      ),
      es AS (
        SELECT
          date_trunc('day', spent_at)::date AS day,
          COALESCE(SUM(amount),0)::numeric AS expenses
        FROM expenses
        WHERE spent_at >= $1::timestamptz
          AND spent_at <  $2::timestamptz
        GROUP BY 1
      )
      SELECT
        COALESCE(ws.day, es.day)            AS day,
        COALESCE(ws.revenue, 0)::numeric    AS revenue,
        COALESCE(ws.commission, 0)::numeric AS commission,
        COALESCE(ws.profit, 0)::numeric     AS profit,
        COALESCE(es.expenses, 0)::numeric   AS expenses
      FROM ws
      FULL OUTER JOIN es ON ws.day = es.day
      ORDER BY day
    `;

    const [{ rows: [t] }, { rows: series }] = await Promise.all([
      query(totalsSql, [pStart, pEnd]),
      query(seriesSql, [pStart, pEnd]),
    ]);

    const totals = {
      revenue: Number(t?.revenue || 0),
      commission: Number(t?.commission || 0),
      profit: Number(t?.profit || 0),
      expenses: Number(t?.expenses || 0),
      net_income: Number(t?.profit || 0) - Number(t?.expenses || 0),
    };

    const daily = series.map(r => ({
      day: String(r.day),
      revenue: Number(r.revenue || 0),
      commission: Number(r.commission || 0),
      profit: Number(r.profit || 0),
      expenses: Number(r.expenses || 0),
      net: Number(r.profit || 0) - Number(r.expenses || 0),
    }));

    res.json({ range: { start: pStart, end: pEnd }, totals, daily });
  } catch (err) {
    console.error('❌ /reports/profit-loss error:', err);
    res.status(500).json({ error: 'Failed to load profit & loss report.' });
  }
});

export default router;
