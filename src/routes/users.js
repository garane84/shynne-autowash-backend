// backend/src/routes/users.js
import { Router } from 'express';
import { query } from '../db.js';
import bcrypt from 'bcryptjs';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/* ===== Current user ===== */
router.get('/me', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, is_active, created_at, updated_at
       FROM users WHERE id = $1::uuid`,
      [req.user.sub]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error('❌ Error loading profile:', e);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

router.put('/me', async (req, res) => {
  const { name, email, current_password, new_password } = req.body;
  try {
    // If changing password, verify current
    if (new_password) {
      const { rows } = await query(
        'SELECT password_hash FROM users WHERE id = $1::uuid',
        [req.user.sub]
      );
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const ok = await bcrypt.compare((current_password || '').trim(), user.password_hash.trim());
      if (!ok) return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    const hash = new_password ? await bcrypt.hash(new_password.trim(), 10) : null;

    const { rows: upd } = await query(
      `
      UPDATE users SET
        name = COALESCE($1, name),
        email = COALESCE($2, email),
        password_hash = COALESCE($3, password_hash),
        updated_at = now()
      WHERE id = $4::uuid
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [name, email, hash, req.user.sub]
    );

    res.json(upd[0]);
  } catch (e) {
    console.error('❌ Error updating profile:', e);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

/* ===== Admin-only user management ===== */
router.get('/', requireRole('ADMIN'), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, is_active, created_at, updated_at
       FROM users ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error('❌ Error listing users:', e);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { name, email, password, role = 'MANAGER', is_active = true } = req.body;
  try {
    const hash = await bcrypt.hash(password.trim(), 10);
    const { rows } = await query(
      `INSERT INTO users (id, name, email, password_hash, role, is_active, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::user_role, $5, now(), now())
       RETURNING id, name, email, role, is_active, created_at, updated_at`,
      [name, email, hash, role, is_active]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('❌ Error creating user:', e);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { name, email, role, is_active, password } = req.body;
  try {
    const hash = password ? await bcrypt.hash(password.trim(), 10) : null;
    const { rows } = await query(
      `
      UPDATE users SET
        name = COALESCE($1, name),
        email = COALESCE($2, email),
        role = COALESCE($3::user_role, role),
        is_active = COALESCE($4, is_active),
        password_hash = COALESCE($5, password_hash),
        updated_at = now()
      WHERE id = $6::uuid
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [name, email, role, is_active, hash, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (e) {
    console.error('❌ Error updating user:', e);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await query('DELETE FROM users WHERE id = $1::uuid', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error deleting user:', e);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

export default router;
