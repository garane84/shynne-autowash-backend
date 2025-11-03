// backend/src/routes/expenses.js
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** -----------------------------
 * GET /expenses?month=YYYY-MM
 * (Defaults to current month)
 ------------------------------*/
router.get('/', async (req, res) => {
  try {
    const { month } = req.query;

    const where = [];
    const params = [];

    if (month) {
      params.push(`${month}-01`);
      where.push(`
        spent_at >= date_trunc('month', $${params.length}::date)
        AND spent_at < (date_trunc('month', $${params.length}::date) + interval '1 month')
      `);
    } else {
      where.push(`
        spent_at >= date_trunc('month', now())
        AND spent_at < (date_trunc('month', now()) + interval '1 month')
      `);
    }

    const sql = `
      SELECT
        id,
        category,
        note AS description,
        amount,
        spent_at,
        NULL::text AS receipt_no
      FROM expenses
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY spent_at DESC, created_by_user_id NULLS LAST
    `;

    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /expenses failed:', err);
    res.status(500).json({ error: 'Failed to load expenses.' });
  }
});

/** -----------------------------
 * POST /expenses
 * Accepts either:
 *  { category, amount, date, description }
 * or legacy:
 *  { category, amount, spent_at, note, receipt_no }
 ------------------------------*/
router.post('/', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    // Accept multiple field names
    const category = req.body.category;
    const rawAmount = req.body.amount;
    const description = req.body.description ?? req.body.note ?? null;
    const dateStr = req.body.date ?? req.body.spent_at ?? null;

    // Parse/validate amount
    const amount = Number(rawAmount);
    if (!category || Number.isNaN(amount)) {
      return res
        .status(400)
        .json({ error: 'category and a numeric amount are required' });
    }

    // Parse date (optional)
    // Accepts "YYYY-MM-DD" or ISO; fallback to now()
    let when = null;
    if (dateStr) {
      const d = new Date(dateStr);
      if (!Number.isNaN(d.getTime())) when = d.toISOString();
    }

    const { rows } = await query(
      `
      INSERT INTO expenses (category, note, amount, spent_at, created_by_user_id)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5::uuid)
      RETURNING
        id,
        category,
        note AS description,
        amount,
        spent_at,
        NULL::text AS receipt_no
      `,
      [category, description, amount, when, req.user?.sub ?? null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('❌ POST /expenses failed:', err);
    res.status(500).json({ error: 'Failed to create expense.' });
  }
});

/** -----------------------------
 * PUT /expenses/:id
 ------------------------------*/
router.put('/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    const category = req.body.category ?? null;
    const description = req.body.description ?? req.body.note ?? null;

    // Allow amount/date to be omitted or sent in either style
    const rawAmount = req.body.amount;
    const amount =
      rawAmount === undefined || rawAmount === null
        ? null
        : Number(rawAmount);

    const dateStr = req.body.date ?? req.body.spent_at ?? null;
    const when =
      dateStr && !Number.isNaN(new Date(dateStr).getTime())
        ? new Date(dateStr).toISOString()
        : null;

    const { rows } = await query(
      `
      UPDATE expenses
      SET
        category = COALESCE($1, category),
        note      = COALESCE($2, note),
        amount    = COALESCE($3, amount),
        spent_at  = COALESCE($4::timestamptz, spent_at)
      WHERE id = $5::uuid
      RETURNING
        id,
        category,
        note AS description,
        amount,
        spent_at,
        NULL::text AS receipt_no
      `,
      [category, description, amount, when, id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Expense not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ PUT /expenses failed:', err);
    res.status(500).json({ error: 'Failed to update expense.' });
  }
});

/** -----------------------------
 * DELETE /expenses/:id
 ------------------------------*/
router.delete('/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await query('DELETE FROM expenses WHERE id = $1::uuid', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Expense not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /expenses failed:', err);
    res.status(500).json({ error: 'Failed to delete expense.' });
  }
});

export default router;
