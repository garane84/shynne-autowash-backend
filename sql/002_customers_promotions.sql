-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  phone TEXT,
  vehicle_reg TEXT,
  visits_count INT NOT NULL DEFAULT 0,
  last_visit TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_vehicle ON customers (vehicle_reg);

-- Promotions catalog (optional; future use)
CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,           -- e.g. 'FREE_WASH'
  name TEXT NOT NULL,                  -- 'Random Free Wash'
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link promos to washes
ALTER TABLE washes
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id),
  ADD COLUMN IF NOT EXISTS promo_id UUID REFERENCES promotions(id),
  ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;

-- Default promo row (optional)
INSERT INTO promotions (code, name)
SELECT 'FREE_WASH', 'Random Free Wash'
WHERE NOT EXISTS (SELECT 1 FROM promotions WHERE code='FREE_WASH');
