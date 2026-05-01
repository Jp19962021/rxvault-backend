-- ============================================================
-- RXVAULT PLATFORM — COMPLETE DATABASE SCHEMA
-- Run this in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── CLINICS (vet practices) ──────────────────────────────────────────────────
CREATE TABLE clinics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,          -- subdomain: smithanimalclinic
  subdomain       TEXT UNIQUE NOT NULL,          -- smithanimalclinic.yourdomain.com
  status          TEXT DEFAULT 'pending',        -- pending | active | suspended
  plan            TEXT DEFAULT 'starter',        -- starter | growth | enterprise

  -- Contact
  email           TEXT NOT NULL,
  phone           TEXT,
  address1        TEXT,
  address2        TEXT,
  city            TEXT,
  state           TEXT,
  zip_code        TEXT,

  -- Vet license info (passed to PCP on every order)
  vet_name        TEXT,
  license_id      TEXT,
  license_state   TEXT,
  fax_number      TEXT,
  pcp_key         TEXT,                          -- clinic-specific PCP key if needed

  -- Branding
  logo_url        TEXT,
  brand_color     TEXT DEFAULT '#2563EB',
  template        TEXT DEFAULT 'light',          -- light | dark
  tagline         TEXT,
  welcome_message TEXT,
  store_hours     TEXT,
  faq_data        JSONB DEFAULT '[]',

  -- Email/SMS config
  klaviyo_list_id TEXT,
  twilio_phone    TEXT,
  omnisend_api_key TEXT,
  email_platform  TEXT DEFAULT 'klaviyo',       -- klaviyo | omnisend

  -- Revenue
  total_revenue   NUMERIC(10,2) DEFAULT 0,
  total_orders    INTEGER DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CLINIC USERS (vet staff logins) ──────────────────────────────────────────
CREATE TABLE clinic_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id) ON DELETE CASCADE,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  role            TEXT DEFAULT 'admin',          -- admin | staff
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── PLATFORM ADMINS (JP's team) ──────────────────────────────────────────────
CREATE TABLE admins (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  name            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── PRODUCTS (synced from PCP API) ───────────────────────────────────────────
CREATE TABLE products (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_sku                  TEXT UNIQUE NOT NULL,
  product_title             TEXT,
  product_name              TEXT,
  brand_name                TEXT,
  manufacturer_name         TEXT,
  unit_price                NUMERIC(10,2),       -- PCP cost to you
  msrp                      NUMERIC(10,2),
  map                       NUMERIC(10,2),
  pcpsrp                    NUMERIC(10,2),
  prescription_required     BOOLEAN DEFAULT TRUE,
  requires_refrigeration    BOOLEAN DEFAULT FALSE,
  animal_type               TEXT,               -- Dog | Cat | Both
  product_type              TEXT,
  flavor                    TEXT,
  unit_of_measure           TEXT,
  sku_size                  TEXT,
  sku_count                 TEXT,
  quantity_available        INTEGER,
  item_status               TEXT,
  ingredients               TEXT,
  directions                TEXT,
  cautions                  TEXT,
  storage                   TEXT,
  product_long_desc         TEXT,
  product_html_desc         TEXT,
  image_url                 TEXT,
  image_urls                JSONB DEFAULT '[]',
  bullet_points             JSONB DEFAULT '[]',
  sku_variants              JSONB DEFAULT '[]',
  keywords                  TEXT,
  prop65                    BOOLEAN DEFAULT FALSE,
  gtin                      TEXT,
  last_synced_at            TIMESTAMPTZ DEFAULT NOW(),
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- ── CLINIC PRODUCTS (per-clinic toggle/pricing) ───────────────────────────────
CREATE TABLE clinic_products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
  is_visible      BOOLEAN DEFAULT TRUE,          -- show/hide on storefront
  is_featured     BOOLEAN DEFAULT FALSE,         -- star/pin to top
  markup_price    NUMERIC(10,2),                 -- clinic's selling price
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, product_id)
);

-- ── CUSTOMERS (pet owners) ───────────────────────────────────────────────────
CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  password_hash   TEXT,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  phone           TEXT,
  address1        TEXT,
  address2        TEXT,
  city            TEXT,
  state           TEXT,
  zip_code        TEXT,
  sms_opt_in      BOOLEAN DEFAULT TRUE,
  email_opt_in    BOOLEAN DEFAULT TRUE,
  stripe_customer_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, email)
);

-- ── PETS ─────────────────────────────────────────────────────────────────────
CREATE TABLE pets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  clinic_id       UUID REFERENCES clinics(id),
  name            TEXT NOT NULL,
  species         TEXT,                          -- Dog | Cat | Other
  breed           TEXT,
  birth_date      DATE,
  gender          TEXT,
  weight          NUMERIC(6,2),
  medical_notes   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── PRESCRIPTIONS ─────────────────────────────────────────────────────────────
CREATE TABLE prescriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id),
  customer_id     UUID REFERENCES customers(id),
  pet_id          UUID REFERENCES pets(id),
  product_id      UUID REFERENCES products(id),
  status          TEXT DEFAULT 'pending',        -- pending | approved | denied | expired
  is_refill       BOOLEAN DEFAULT FALSE,
  refill_number   TEXT DEFAULT '0',
  refills_remaining INTEGER DEFAULT 0,
  instructions    TEXT,
  medical_description TEXT,
  approved_by     TEXT,                          -- vet name
  approved_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  sms_sent_at     TIMESTAMPTZ,                   -- when cart link was texted
  cart_link_token TEXT UNIQUE,                   -- unique token for SMS cart link
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── ORDERS ────────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id),
  customer_id     UUID REFERENCES customers(id),
  pet_id          UUID REFERENCES pets(id),

  -- Status
  status          TEXT DEFAULT 'pending',        -- pending | processing | submitted_to_pcp | shipped | delivered | cancelled

  -- Shipping
  ship_method     TEXT DEFAULT 'STANDARD',
  address1        TEXT,
  address2        TEXT,
  city            TEXT,
  state           TEXT,
  zip_code        TEXT,

  -- Payment
  stripe_payment_intent_id TEXT,
  subtotal        NUMERIC(10,2),
  tax             NUMERIC(10,2),
  shipping_cost   NUMERIC(10,2) DEFAULT 0,
  total           NUMERIC(10,2),

  -- PCP fulfillment
  pcp_order_id    TEXT,                          -- ID returned by PCP
  pcp_submitted_at TIMESTAMPTZ,
  tracking_number TEXT,
  carrier         TEXT,
  ship_date       TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,

  -- AutoShip
  is_autoship     BOOLEAN DEFAULT FALSE,
  autoship_interval_days INTEGER,
  next_autoship_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── ORDER ITEMS ───────────────────────────────────────────────────────────────
CREATE TABLE order_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders(id) ON DELETE CASCADE,
  prescription_id UUID REFERENCES prescriptions(id),
  product_id      UUID REFERENCES products(id),
  sku             TEXT,
  product_title   TEXT,
  quantity        INTEGER DEFAULT 1,
  unit_price      NUMERIC(10,2),                 -- clinic's selling price
  pcp_unit_price  NUMERIC(10,2),                 -- PCP cost
  instructions    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── SMS LOG ───────────────────────────────────────────────────────────────────
CREATE TABLE sms_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id),
  customer_id     UUID REFERENCES customers(id),
  prescription_id UUID REFERENCES prescriptions(id),
  order_id        UUID REFERENCES orders(id),

  -- Message details
  to_number       TEXT NOT NULL,
  from_number     TEXT NOT NULL,
  body            TEXT NOT NULL,
  type            TEXT,                          -- rx_approved | cart_link | shipping | refill_reminder | autoship_reminder | delivery

  -- Twilio response
  twilio_sid      TEXT,
  status          TEXT DEFAULT 'queued',         -- queued | sent | delivered | failed | bounced
  error_code      TEXT,
  error_message   TEXT,

  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ
);

-- ── EMAIL LOG ─────────────────────────────────────────────────────────────────
CREATE TABLE email_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id),
  customer_id     UUID REFERENCES customers(id),
  to_email        TEXT NOT NULL,
  subject         TEXT,
  type            TEXT,                          -- welcome | rx_approved | order_confirmed | shipping | refill_reminder
  platform        TEXT,                          -- klaviyo | omnisend
  external_id     TEXT,                          -- Klaviyo/Omnisend message ID
  status          TEXT DEFAULT 'sent',
  sent_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUTOSHIP ──────────────────────────────────────────────────────────────────
CREATE TABLE autoship_subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinic_id       UUID REFERENCES clinics(id),
  customer_id     UUID REFERENCES customers(id),
  pet_id          UUID REFERENCES pets(id),
  prescription_id UUID REFERENCES prescriptions(id),
  product_id      UUID REFERENCES products(id),
  status          TEXT DEFAULT 'active',         -- active | paused | cancelled
  interval_days   INTEGER DEFAULT 30,
  next_order_at   TIMESTAMPTZ,
  last_order_id   UUID REFERENCES orders(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_clinic_products_clinic ON clinic_products(clinic_id);
CREATE INDEX idx_prescriptions_clinic ON prescriptions(clinic_id);
CREATE INDEX idx_prescriptions_status ON prescriptions(status);
CREATE INDEX idx_prescriptions_token ON prescriptions(cart_link_token);
CREATE INDEX idx_orders_clinic ON orders(clinic_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_sms_log_clinic ON sms_log(clinic_id);
CREATE INDEX idx_customers_clinic ON customers(clinic_id);

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clinics_updated BEFORE UPDATE ON clinics FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_prescriptions_updated BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_clinic_products_updated BEFORE UPDATE ON clinic_products FOR EACH ROW EXECUTE FUNCTION update_updated_at();
