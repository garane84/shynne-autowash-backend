import { Router } from 'express';
import { query } from '../db.js';
import bcrypt from 'bcryptjs';
import { signToken } from '../utils/jwt.js';

const router = Router();

// ✅ LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email & password required' });

    const { rows } = await query(
      'SELECT * FROM users WHERE email=$1 AND is_active=true',
      [email]
    );
    const user = rows[0];
    if (!user)
      return res.status(401).json({ error: 'Invalid credentials' });

    // Compare bcrypt password correctly
    const ok = await bcrypt.compare(password.trim(), user.password_hash.trim());
    if (!ok)
      return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    delete user.password_hash;

    res.json({ token, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ REGISTER (helper to add users manually)
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role = 'MANAGER' } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: 'Name, email & password required' });

    const hash = await bcrypt.hash(password.trim(), 10);
    const { rows } = await query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hash, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

export default router;
