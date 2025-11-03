// backend/src/routes/staff.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// 🕒 Helper: filter by time period
function periodFilter(period = "today") {
  switch (period) {
    case "week":
      return `AND w.washed_at >= NOW() - INTERVAL '7 days'`;
    case "month":
      return `AND w.washed_at >= NOW() - INTERVAL '30 days'`;
    default:
      return `AND DATE(w.washed_at) = CURRENT_DATE`;
  }
}

/* ==========================================
   GET all staff + washes + commission summary
========================================== */
router.get("/", async (req, res) => {
  const { period = "today" } = req.query;

  try {
    const { rows: staff } = await query(`
      SELECT 
        id, name, phone, role_label, is_active, created_at, updated_at,
        email, national_id, address, date_of_birth, hire_date, gender,
        emergency_contact_name, emergency_contact_phone, photo_url
      FROM staff
      ORDER BY name ASC
    `);

    const { rows: stats } = await query(
      `
      SELECT
        s.id AS staff_id,
        COUNT(w.id) AS washes,
        COALESCE(SUM(w.unit_price * COALESCE(w.commission_pct, 30) / 100), 0) AS commission
      FROM staff s
      LEFT JOIN washes w ON w.staff_id = s.id
      ${periodFilter(period)}
      GROUP BY s.id
      `
    );

    const merged = staff.map((s) => {
      const st = stats.find((x) => x.staff_id === s.id) || {
        washes: 0,
        commission: 0,
      };
      return {
        ...s,
        washes_today: Number(st.washes),
        commission_today: Number(st.commission),
      };
    });

    res.json(merged);
  } catch (err) {
    console.error("❌ Error fetching staff list:", err);
    res.status(500).json({ error: "Failed to load staff with commissions." });
  }
});

/* ==========================================
   CREATE staff
========================================== */
router.post("/", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const {
    name,
    phone,
    role_label = "Staff",
    // new optional fields:
    email,
    national_id,
    address,
    date_of_birth,      // expect 'YYYY-MM-DD' or null
    hire_date,          // expect 'YYYY-MM-DD' or null
    gender,             // e.g. 'Male' | 'Female' | 'Other'
    emergency_contact_name,
    emergency_contact_phone,
    photo_url,
    is_active = true,
  } = req.body;

  try {
    const { rows } = await query(
      `
      INSERT INTO staff (
        id, name, phone, role_label, is_active, created_at, updated_at,
        email, national_id, address, date_of_birth, hire_date, gender,
        emergency_contact_name, emergency_contact_phone, photo_url
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW(),
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13
      )
      RETURNING *
      `,
      [
        name,
        phone,
        role_label,
        is_active,
        email,
        national_id,
        address,
        date_of_birth || null,
        hire_date || null,
        gender,
        emergency_contact_name,
        emergency_contact_phone,
        photo_url,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("❌ Error adding staff:", err);
    // Handle unique email constraint gracefully
    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already in use for another staff." });
    }
    res.status(500).json({ error: "Failed to add staff." });
  }
});

/* ==========================================
   UPDATE staff
========================================== */
router.put("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  const {
    name,
    phone,
    role_label,
    is_active,
    // new optional fields:
    email,
    national_id,
    address,
    date_of_birth,
    hire_date,
    gender,
    emergency_contact_name,
    emergency_contact_phone,
    photo_url,
  } = req.body;

  try {
    const { rows } = await query(
      `
      UPDATE staff
      SET name = COALESCE($1, name),
          phone = COALESCE($2, phone),
          role_label = COALESCE($3, role_label),
          is_active = COALESCE($4, is_active),
          email = COALESCE($5, email),
          national_id = COALESCE($6, national_id),
          address = COALESCE($7, address),
          date_of_birth = COALESCE($8, date_of_birth),
          hire_date = COALESCE($9, hire_date),
          gender = COALESCE($10, gender),
          emergency_contact_name = COALESCE($11, emergency_contact_name),
          emergency_contact_phone = COALESCE($12, emergency_contact_phone),
          photo_url = COALESCE($13, photo_url),
          updated_at = NOW()
      WHERE id = $14::uuid
      RETURNING *
      `,
      [
        name,
        phone,
        role_label,
        is_active,
        email,
        national_id,
        address,
        date_of_birth || null,
        hire_date || null,
        gender,
        emergency_contact_name,
        emergency_contact_phone,
        photo_url,
        id,
      ]
    );

    if (!rows[0]) return res.status(404).json({ error: "Staff not found." });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error updating staff:", err);
    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already in use for another staff." });
    }
    res.status(500).json({ error: "Failed to update staff." });
  }
});

/* ==========================================
   DELETE staff
========================================== */
router.delete("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await query(
      "DELETE FROM staff WHERE id = $1::uuid",
      [id]
    );
    if (rowCount === 0)
      return res.status(404).json({ error: "Staff not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error deleting staff:", err);
    res.status(500).json({ error: "Failed to delete staff." });
  }
});

export default router;
