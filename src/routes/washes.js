// backend/src/routes/washes.js
import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

/* -------------------------------------------
   Receipt ID helpers (NEW)
   Format: SH + last 5 of timestamp + 2 random digits (no hyphens)
   Example: SH839521, SH015734
------------------------------------------- */
function generateReceiptID() {
  const prefix = "SH";
  const ts = Date.now().toString().slice(-5);         // last 5 digits of timestamp
  const rnd = Math.floor(Math.random() * 90 + 10);    // 2 random digits 10–99
  return `${prefix}${ts}${rnd}`;
}

async function generateUniqueReceiptNo() {
  for (let i = 0; i < 5; i++) {
    const candidate = generateReceiptID();
    const { rows } = await query(
      "SELECT 1 FROM washes WHERE receipt_no = $1 LIMIT 1",
      [candidate]
    );
    if (rows.length === 0) return candidate;
  }
  return `SH${Date.now()}`; // ultra-rare fallback
}

/* -------------------------------------------
   Helpers for promotions (existing + new)
------------------------------------------- */
async function getAppSettings() {
  const { rows } = await query("SELECT * FROM app_settings WHERE id=1");
  return rows[0] || {};
}

async function countFreeToday() {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS c FROM washes WHERE is_free = TRUE AND DATE(washed_at) = CURRENT_DATE"
  );
  return rows[0]?.c || 0;
}

async function getFreePromoId() {
  const { rows } = await query(
    "SELECT id FROM promotions WHERE code='FREE_WASH' AND is_active=TRUE"
  );
  return rows[0]?.id || null;
}

/* ✅ Loyalty promo (13th wash this month) */
async function countCustomerWashesThisMonth(customerId, washedAt) {
  if (!customerId) return 0;
  const { rows } = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM washes
    WHERE customer_id = $1::uuid
      AND date_trunc('month', washed_at) = date_trunc('month', COALESCE($2::timestamptz, now()))
    `,
    [customerId, washedAt || null]
  );
  return rows[0]?.c || 0;
}

async function getLoyaltyPromoId() {
  const { rows } = await query(
    "SELECT id FROM promotions WHERE code='LOYALTY_13TH' AND is_active=TRUE"
  );
  return rows[0]?.id || null;
}

/* ✅ Featured vehicles monthly reward (NEW) */
function firstDayOfMonth(d) {
  const dt = d ? new Date(d) : new Date();
  return new Date(dt.getFullYear(), dt.getMonth(), 1);
}

async function isVehicleFeaturedForMonth(vehicle_reg, washedAt) {
  if (!vehicle_reg) return null;
  const month = firstDayOfMonth(washedAt).toISOString().slice(0, 10); // YYYY-MM-DD
  const { rows } = await query(
    `SELECT * FROM featured_vehicles WHERE vehicle_reg = $1 AND month = $2::date LIMIT 1`,
    [vehicle_reg.trim(), month]
  );
  return rows[0] || null;
}

async function hasUsedFeaturedRewardThisMonth(vehicle_reg, washedAt) {
  if (!vehicle_reg) return false;
  const monthStart = firstDayOfMonth(washedAt);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const { rows } = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM washes w
    LEFT JOIN promotions p ON p.id = w.promo_id
    WHERE w.vehicle_reg = $1
      AND w.is_free = TRUE
      AND p.code = 'FEATURED_VEHICLE'
      AND w.washed_at >= $2::timestamptz
      AND w.washed_at < $3::timestamptz
    `,
    [vehicle_reg.trim(), monthStart.toISOString(), monthEnd.toISOString()]
  );
  return (rows[0]?.c || 0) > 0;
}

async function getFeaturedPromoId() {
  const { rows } = await query(
    "SELECT id FROM promotions WHERE code='FEATURED_VEHICLE' AND is_active=TRUE"
  );
  return rows[0]?.id || null;
}

/* ✅ Upsert/find customer */
async function upsertCustomer({ name, phone, vehicle_reg }) {
  if (!phone && !vehicle_reg) return null;

  let customer = null;
  if (phone) {
    const r = await query("SELECT * FROM customers WHERE phone = $1", [phone]);
    customer = r.rows[0] || null;
  }
  if (!customer && vehicle_reg) {
    const r = await query("SELECT * FROM customers WHERE vehicle_reg = $1", [
      vehicle_reg,
    ]);
    customer = r.rows[0] || null;
  }

  if (!customer) {
    const ins = await query(
      `INSERT INTO customers (name, phone, vehicle_reg, visits_count, last_visit)
       VALUES ($1,$2,$3,0,NULL)
       RETURNING *`,
      [name || null, phone || null, vehicle_reg || null]
    );
    customer = ins.rows[0];
  } else {
    await query(
      `UPDATE customers
         SET name = COALESCE($1, name),
             vehicle_reg = COALESCE($2, vehicle_reg),
             updated_at = now()
       WHERE id=$3`,
      [name || null, vehicle_reg || null, customer.id]
    );
  }

  return customer.id;
}

/* ================================
   CREATE WASH (Admin / Manager)
================================ */
router.post("/", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const {
    service_id,
    car_type_id,
    staff_id = null,
    unit_price = null,
    washed_at = null,
    commission_pct = 30.0,

    // optional customer fields
    customer_name,
    customer_phone,
    vehicle_reg,
  } = req.body;

  if (!service_id || !car_type_id)
    return res
      .status(400)
      .json({ error: "service_id and car_type_id are required." });

  try {
    // Get default price if not provided
    let price = unit_price;
    if (price === null) {
      const { rows } = await query(
        `SELECT price 
         FROM service_prices 
         WHERE service_id = $1::uuid 
           AND car_type_id = $2::uuid`,
        [service_id, car_type_id]
      );
      if (!rows[0])
        return res
          .status(400)
          .json({ error: "Price not configured for service & car type." });
      price = rows[0].price;
    }

    // Promo / Loyalty evaluation (priority: Featured > Loyalty 13th > Random)
    let customerId = null;
    let isFree = false;
    let promoId = null;
    let commissionPctEffective = commission_pct;

    try {
      customerId = await upsertCustomer({
        name: customer_name,
        phone: customer_phone,
        vehicle_reg,
      });

      /* (0) Featured vehicle free once per month */
      const featured = await isVehicleFeaturedForMonth(vehicle_reg, washed_at);
      if (featured) {
        const alreadyUsed = await hasUsedFeaturedRewardThisMonth(
          vehicle_reg,
          washed_at
        );
        // You can also respect app_settings.featured_free_once_per_month (default true)
        const settings = await getAppSettings();
        const enforceOnce =
          settings.featured_free_once_per_month !== false; // default true
        const canGrant = enforceOnce ? !alreadyUsed : true;

        if (canGrant) {
          const fPromo = await getFeaturedPromoId();
          if (fPromo) {
            isFree = true;
            price = 0;
            commissionPctEffective = 0;
            promoId = fPromo;
          }
        }
      }

      /* (1) Loyalty: every 13th wash this month => FREE (only if not already free) */
      if (!isFree && customerId) {
        const cnt = await countCustomerWashesThisMonth(customerId, washed_at);
        if ((cnt + 1) % 13 === 0) {
          isFree = true;
          price = 0;
          commissionPctEffective = 0;
          promoId = await getLoyaltyPromoId(); // may be null
        }
      }

      /* (2) Random promo only if not already free */
      if (!isFree) {
        const s = await getAppSettings();
        const promoEnabled = !!s.promo_free_enabled;
        const prob = Number(s.promo_free_prob || 0); // e.g. 0.05 = 5%
        const minVisits = Number(s.promo_free_min_visits || 0);
        const dailyCap = Number(s.promo_free_daily_cap || 0);

        if (promoEnabled && customerId) {
          const { rows: crow } = await query(
            "SELECT visits_count FROM customers WHERE id=$1",
            [customerId]
          );
          const visits = Number(crow[0]?.visits_count || 0);

          if (visits >= minVisits) {
            const todayUsed = await countFreeToday();
            const underCap = !dailyCap || todayUsed < dailyCap;

            if (underCap && Math.random() < prob) {
              const freeId = await getFreePromoId();
              if (freeId) {
                isFree = true;
                price = 0;
                commissionPctEffective = 0;
                promoId = freeId;
              }
            }
          }
        }
      }
    } catch (promoErr) {
      console.warn("⚠️ Promo logic skipped due to error:", promoErr);
      isFree = false;
      commissionPctEffective = isNaN(commissionPctEffective)
        ? commission_pct
        : commissionPctEffective;
    }

    // Commission & profit
    const commission_amount =
      Math.round(((Number(price) * commissionPctEffective) / 100.0) * 100) /
      100;
    const profit_amount =
      Math.round((Number(price) - commission_amount) * 100) / 100;

    // New SH-style receipt number
    const receiptNo = await generateUniqueReceiptNo();

    // Insert wash  (NOTE: now also storing vehicle_reg)
    const { rows } = await query(
      `
      INSERT INTO washes (
        id, service_id, car_type_id, staff_id,
        unit_price, commission_pct, commission_amount, profit_amount,
        washed_at, created_by_user_id, receipt_no, created_at, updated_at,
        customer_id, promo_id, is_free, vehicle_reg
      )
      VALUES (
        gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
        $4, $5, $6, $7,
        COALESCE($8, now()), $9::uuid, $10, now(), now(),
        $11::uuid, $12::uuid, $13, $14
      )
      RETURNING *
      `,
      [
        service_id,
        car_type_id,
        staff_id,
        price,
        commissionPctEffective,
        commission_amount,
        profit_amount,
        washed_at,
        req.user?.sub,
        receiptNo,
        customerId,
        promoId,
        isFree,
        vehicle_reg || null,
      ]
    );

    const wash = rows[0];

    if (customerId) {
      await query(
        `UPDATE customers
            SET visits_count = visits_count + 1,
                last_visit = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        [customerId]
      );
    }

    res.status(201).json(wash);
  } catch (err) {
    console.error("❌ Error creating wash:", err);
    res.status(500).json({ error: "Failed to create wash record." });
  }
});

/* ================================
   LIST WASHES (All Authenticated)
================================ */
router.get("/", async (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const params = [];

  if (from) {
    params.push(from);
    where.push(`w.washed_at >= $${params.length}::timestamp`);
  }
  if (to) {
    params.push(to);
    where.push(`w.washed_at < ($${params.length}::date + interval '1 day')`);
  }

  const sql = `
    SELECT 
      w.*, 
      s.name AS service_name, 
      ct.label AS car_type_label, 
      st.name AS staff_name
    FROM washes w
    JOIN services s ON s.id = w.service_id
    JOIN car_types ct ON ct.id = w.car_type_id
    LEFT JOIN staff st ON st.id = w.staff_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY w.washed_at DESC
  `;

  try {
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error listing washes:", err);
    res.status(500).json({ error: "Failed to fetch wash records." });
  }
});

/* ================================
   GET WASH RECEIPT
================================ */
router.get("/:id/receipt", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await query(
      `
      SELECT
        w.id,
        w.receipt_no,
        w.unit_price,
        w.commission_pct,
        w.commission_amount,
        w.profit_amount,
        w.is_free,
        w.vehicle_reg,
        p.name AS promo_name,
        to_char(w.washed_at, 'YYYY-MM-DD HH24:MI') AS washed_at,
        s.name AS service_name,
        ct.label AS car_type_label,
        st.name AS staff_name
      FROM washes w
      JOIN services s ON s.id = w.service_id
      JOIN car_types ct ON ct.id = w.car_type_id
      LEFT JOIN staff st ON st.id = w.staff_id
      LEFT JOIN promotions p ON p.id = w.promo_id
      WHERE w.id = $1::uuid
      `,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ error: "Receipt not found." });

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error fetching receipt:", err);
    res.status(500).json({ error: "Failed to load receipt." });
  }
});

/* ================================
   UPDATE WASH
================================ */
router.put("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  const {
    service_id,
    car_type_id,
    staff_id = null,
    unit_price = null,
    washed_at = null,
    commission_pct = 30.0,
  } = req.body;

  try {
    const { rows: existingRows } = await query(
      "SELECT * FROM washes WHERE id = $1::uuid",
      [id]
    );
    if (existingRows.length === 0)
      return res.status(404).json({ error: "Wash record not found." });

    const price = unit_price ?? existingRows[0].unit_price;
    const commission_amount =
      Math.round(((Number(price) * commission_pct) / 100.0) * 100) / 100;
    const profit_amount =
      Math.round((Number(price) - commission_amount) * 100) / 100;

    const { rows } = await query(
      `
      UPDATE washes
      SET service_id = COALESCE($1::uuid, service_id),
          car_type_id = COALESCE($2::uuid, car_type_id),
          staff_id = COALESCE($3::uuid, staff_id),
          unit_price = COALESCE($4, unit_price),
          commission_pct = COALESCE($5, commission_pct),
          commission_amount = $6,
          profit_amount = $7,
          washed_at = COALESCE($8, washed_at),
          updated_at = now()
      WHERE id = $9::uuid
      RETURNING *
      `,
      [
        service_id ?? existingRows[0].service_id,
        car_type_id ?? existingRows[0].car_type_id,
        staff_id,
        price,
        commission_pct,
        commission_amount,
        profit_amount,
        washed_at,
        id,
      ]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error updating wash record:", err);
    res.status(500).json({ error: "Failed to update wash record." });
  }
});

/* ================================
   DELETE WASH
================================ */
router.delete("/:id", requireRole("ADMIN", "MANAGER"), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query(
      "DELETE FROM washes WHERE id = $1::uuid RETURNING id",
      [id]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Wash record not found." });
    res.json({ ok: true, message: "Wash record deleted successfully." });
  } catch (err) {
    console.error("❌ Error deleting wash record:", err);
    res.status(500).json({ error: "Failed to delete wash record." });
  }
});

export default router;
