-- ============================================
-- App-wide Settings (single row)
-- ============================================
CREATE TABLE IF NOT EXISTS app_settings (
  id            int PRIMARY KEY DEFAULT 1,
  business_name text NOT NULL DEFAULT 'Shynny Autowash',
  business_address text DEFAULT 'Kismayu Rd, Next to Ocean Hotel, Garissa',
  business_phone  text DEFAULT '+254700000000',
  currency_code   text NOT NULL DEFAULT 'KES',
  timezone        text NOT NULL DEFAULT 'Africa/Nairobi',
  default_commission_pct numeric(5,2) NOT NULL DEFAULT 30.00 CHECK (default_commission_pct >= 0 AND default_commission_pct <= 100),

  receipt_header  text DEFAULT 'Shynny Autowash | +254700000000',
  receipt_footer  text DEFAULT 'Thank you for your business!',
  show_staff_on_receipt boolean NOT NULL DEFAULT true,

  updated_at timestamptz NOT NULL DEFAULT now()
);

-- seed single row if empty
INSERT INTO app_settings(id)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE id=1);
