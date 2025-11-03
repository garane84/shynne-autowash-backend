// backend/src/routes/settings.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/* --------------------------------------
 * Helpers
 * ------------------------------------ */
function sanitizeUser(u) {
  if (!u) return u;
  const { password_hash, ...rest } = u;
  return rest;
}

async function countActiveAdmins() {
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM users WHERE role='ADMIN' AND is_active=TRUE`
  );
  return Number(count || 0);
}

/* --------------------------------------
 * Business / Receipt Settings
 * (single row table: app_settings with id=1)
 * ------------------------------------ */

/** GET settings */
router.get('/', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM app_settings WHERE id=1');
    res.json(rows[0] || null);
  } catch (e) {
    console.error('❌ Error loading settings:', e);
    res.status(500).json({ error: 'Failed to load settings.' });
  }
});

/** UPDATE settings
 * Admin + Manager allowed to update business/receipt prefs.
 * If you want to restrict some fields to ADMIN only, add checks here.
 */
router.put('/', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const {
    business_name,
    business_address,
    business_phone,
    currency_code,
    timezone,
    default_commission_pct,
    receipt_header,
    receipt_footer,
    show_staff_on_receipt,
  } = req.body;

  try {
    const { rows } = await query(
      `
      UPDATE app_settings SET
        business_name = COALESCE($1, business_name),
        business_address = COALESCE($2, business_address),
        business_phone = COALESCE($3, business_phone),
        currency_code = COALESCE($4, currency_code),
        timezone = COALESCE($5, timezone),
        default_commission_pct = COALESCE($6, default_commission_pct),
        receipt_header = COALESCE($7, receipt_header),
        receipt_footer = COALESCE($8, receipt_footer),
        show_staff_on_receipt = COALESCE($9, show_staff_on_receipt),
        updated_at = now()
      WHERE id = 1
      RETURNING *
      `,
      [
        business_name,
        business_address,
        business_phone,
        currency_code,
        timezone,
        default_commission_pct,
        receipt_header,
        receipt_footer,
        show_staff_on_receipt,
      ]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('❌ Error updating settings:', e);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

/* --------------------------------------
 * Account (current user) endpoints
 * ------------------------------------ */

/** GET /settings/me - current user profile */
router.get('/me', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, is_active, created_at, updated_at
       FROM users WHERE id = $1::uuid`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error('❌ Error loading account:', e);
    res.status(500).json({ error: 'Failed to load account.' });
  }
});

/** PUT /settings/me - update name/email (self) */
router.put('/me', async (req, res) => {
  const { name, email } = req.body;
  try {
    // Ensure unique email if changing
    if (email) {
      const { rows: existing } = await query(
        `SELECT id FROM users WHERE lower(email)=lower($1) AND id <> $2::uuid`,
        [email, req.user.id]
      );
      if (existing.length) {
        return res.status(409).json({ error: 'Email already in use.' });
      }
    }

    const { rows } = await query(
      `
      UPDATE users
      SET name = COALESCE($1, name),
          email = COALESCE($2, email),
          updated_at = now()
      WHERE id = $3::uuid
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [name, email, req.user.id]
    );

    res.json(rows[0] || null);
  } catch (e) {
    console.error('❌ Error updating account:', e);
    res.status(500).json({ error: 'Failed to update account.' });
  }
});

/** PUT /settings/me/password - change own password */
router.put('/me/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current & new password required.' });
  }

  try {
    const { rows } = await query(
      `SELECT id, password_hash FROM users WHERE id = $1::uuid`,
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Current password incorrect.' });

    const hash = await bcrypt.hash(new_password, 10);
    const updated = await query(
      `UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2::uuid
       RETURNING id, name, email, role, is_active, created_at, updated_at`,
      [hash, req.user.id]
    );

    res.json(updated.rows[0]);
  } catch (e) {
    console.error('❌ Error changing password:', e);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

/* --------------------------------------
 * Admin User Management
 * (Admins can manage users; Managers cannot delete.)
 * ------------------------------------ */

/** GET /settings/users - list users (Admin only) */
router.get('/users', requireRole('ADMIN'), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, is_active, created_at, updated_at
       FROM users
       ORDER BY role DESC, name ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error('❌ Error listing users:', e);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

/** POST /settings/users - create user (Admin only) */
router.post('/users', requireRole('ADMIN'), async (req, res) => {
  const { name, email, password, role = 'MANAGER', is_active = true } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email & password required.' });
  }
  if (!['ADMIN', 'MANAGER'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  try {
    const { rows: exists } = await query(
      `SELECT id FROM users WHERE lower(email)=lower($1)`,
      [email]
    );
    if (exists.length) return res.status(409).json({ error: 'Email already in use.' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `
      INSERT INTO users (id, name, email, password_hash, role, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [name, email, hash, role, !!is_active]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('❌ Error creating user:', e);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

/** PUT /settings/users/:id - update user (Admin only) */
router.put('/users/:id', requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { name, email, role, is_active } = req.body;

  try {
    // If changing email, enforce unique
    if (email) {
      const { rows: existing } = await query(
        `SELECT id FROM users WHERE lower(email)=lower($1) AND id <> $2::uuid`,
        [email, id]
      );
      if (existing.length) {
        return res.status(409).json({ error: 'Email already in use.' });
      }
    }

    // If changing role or deactivating, ensure not removing last admin
    if (role === 'MANAGER' || is_active === false) {
      const { rows: [u] } = await query(
        `SELECT id, role, is_active FROM users WHERE id=$1::uuid`,
        [id]
      );
      if (u && u.role === 'ADMIN' && u.is_active) {
        const admins = await countActiveAdmins();
        if (admins <= 1) {
          return res.status(400).json({ error: 'Cannot demote/deactivate the last active admin.' });
        }
      }
    }

    const { rows } = await query(
      `
      UPDATE users
      SET name = COALESCE($1, name),
          email = COALESCE($2, email),
          role = COALESCE($3, role),
          is_active = COALESCE($4, is_active),
          updated_at = now()
      WHERE id = $5::uuid
      RETURNING id, name, email, role, is_active, created_at, updated_at
      `,
      [name, email, role, is_active, id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (e) {
    console.error('❌ Error updating user:', e);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

/** DELETE /settings/users/:id - delete user (Admin only)
 * Prevent deleting yourself and prevent deleting the last active admin.
 */
router.delete('/users/:id', requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;

  if (req.user.id === id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  try {
    const { rows: [u] } = await query(
      `SELECT id, role, is_active FROM users WHERE id=$1::uuid`,
      [id]
    );
    if (!u) return res.status(404).json({ error: 'User not found.' });

    if (u.role === 'ADMIN' && u.is_active) {
      const admins = await countActiveAdmins();
      if (admins <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last active admin.' });
      }
    }

    await query(`DELETE FROM users WHERE id=$1::uuid`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error deleting user:', e);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

export default router;
