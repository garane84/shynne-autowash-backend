-- ============================================
-- CarWash Pro Database Initialization Script
-- ============================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- Enums
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('ADMIN','MANAGER');
  END IF;
END $$;

-- ============================================
-- Users Table
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'MANAGER',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- Staff Table (extended)
CREATE TABLE IF NOT EXISTS staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  role_label TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  email TEXT,
  national_id TEXT,
  address TEXT,
  date_of_birth DATE,
  hire_date DATE,
  gender TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- Car Types Table
-- ============================================
CREATE TABLE IF NOT EXISTS car_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  description TEXT,              -- ✅ added to support detailed descriptions
  sort_order INT NOT NULL DEFAULT 0
);

-- ============================================
-- Services Table
-- ============================================
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,              -- ✅ added to fix “column description does not exist”
  base_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

-- ============================================
-- Service Prices Table
-- ============================================
CREATE TABLE IF NOT EXISTS service_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  car_type_id UUID NOT NULL REFERENCES car_types(id) ON DELETE CASCADE,
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  UNIQUE(service_id, car_type_id)
);

-- ============================================
-- Washes Table
-- ============================================
CREATE TABLE IF NOT EXISTS washes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id),
  car_type_id UUID NOT NULL REFERENCES car_types(id),
  staff_id UUID REFERENCES staff(id),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 30.00 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  commission_amount NUMERIC(12,2) NOT NULL,
  profit_amount NUMERIC(12,2) NOT NULL,
  washed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES users(id),
  receipt_no TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- ✅ added
  updated_at TIMESTAMPTZ,                          -- ✅ added
  CONSTRAINT chk_money CHECK (commission_amount + profit_amount = unit_price)
);

-- ============================================
-- Expenses Table
-- ============================================
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  note TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  spent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID REFERENCES users(id)
);

-- ============================================
-- Commission Rates Table
-- ============================================
CREATE TABLE IF NOT EXISTS commission_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT UNIQUE NOT NULL,
  percentage NUMERIC(5,2) NOT NULL DEFAULT 30.00 CHECK (percentage >= 0 AND percentage <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default commission rates
INSERT INTO commission_rates (role, percentage)
SELECT 'Staff', 30.00
WHERE NOT EXISTS (SELECT 1 FROM commission_rates WHERE role = 'Staff');

INSERT INTO commission_rates (role, percentage)
SELECT 'Manager', 20.00
WHERE NOT EXISTS (SELECT 1 FROM commission_rates WHERE role = 'Manager');

INSERT INTO commission_rates (role, percentage)
SELECT 'Admin', 10.00
WHERE NOT EXISTS (SELECT 1 FROM commission_rates WHERE role = 'Admin');

-- ============================================
-- SEED DATA
-- ============================================

-- Default Admin user
INSERT INTO users (name, email, password_hash, role)
SELECT 'Admin', 'admin@example.com',
  '$2a$10$Y1L1r1wJtn8J0wG3Cfa2ee9x6Ff2wYbQ8m8Tt3qY8yG7a7mF1eV7W', 'ADMIN'
WHERE NOT EXISTS (SELECT 1 FROM users);

-- Default Car Types
INSERT INTO car_types (label, sort_order) SELECT 'Salon/Small',1 WHERE NOT EXISTS (SELECT 1 FROM car_types WHERE label='Salon/Small');
INSERT INTO car_types (label, sort_order) SELECT 'SUV',2 WHERE NOT EXISTS (SELECT 1 FROM car_types WHERE label='SUV');
INSERT INTO car_types (label, sort_order) SELECT 'Van/Bus',3 WHERE NOT EXISTS (SELECT 1 FROM car_types WHERE label='Van/Bus');
INSERT INTO car_types (label, sort_order) SELECT 'Truck',4 WHERE NOT EXISTS (SELECT 1 FROM car_types WHERE label='Truck');

-- Default Services
INSERT INTO services (name, base_price) SELECT 'Full Wash', 600 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name='Full Wash');
INSERT INTO services (name, base_price) SELECT 'Flash', 500 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name='Flash');
INSERT INTO services (name, base_price) SELECT 'Under-Wash', 800 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name='Under-Wash');
INSERT INTO services (name, base_price) SELECT 'Carpet Wash', 1000 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name='Carpet Wash');
INSERT INTO services (name, base_price) SELECT 'Greasing', 400 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name='Greasing');

-- ============================================
-- Default service prices per car type
-- ============================================
DO $$
DECLARE
  s UUID;
  c RECORD;
  p NUMERIC;
BEGIN
  FOR s IN SELECT id FROM services LOOP
    FOR c IN SELECT id, label FROM car_types LOOP
      p := CASE c.label
        WHEN 'Salon/Small' THEN 600
        WHEN 'SUV' THEN 800
        WHEN 'Van/Bus' THEN 1000
        WHEN 'Truck' THEN 1500
        ELSE 0
      END;

      INSERT INTO service_prices(service_id, car_type_id, price)
      SELECT s, c.id, p
      WHERE NOT EXISTS (
        SELECT 1 FROM service_prices sp
        WHERE sp.service_id = s AND sp.car_type_id = c.id
      );
    END LOOP;
  END LOOP;
END $$;

-- ============================================
-- ✅ End of Initialization
-- ============================================
