const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const { sendSMS } = require('../services/smsService');
const { sendEmail } = require('../services/emailService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SALT_ROUNDS = 12;

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

// ── ADMIN LOGIN ───────────────────────────────────────────────────────────────
router.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
  const admin = rows[0];
  if (!admin || !await bcrypt.compare(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken({ id: admin.id, email: admin.email, role: 'admin', name: admin.name });
  res.json({ token, user: { id: admin.id, email: admin.email, role: 'admin', name: admin.name } });
});

// ── CLINIC SIGNUP ─────────────────────────────────────────────────────────────
router.post('/clinic/signup', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      clinicName, slug, email, password, phone,
      vetName, address1, city, state, zipCode,
      template, brandColor, logoUrl
    } = req.body;

    // Check slug availability
    const existing = await client.query('SELECT id FROM clinics WHERE slug = $1', [slug]);
    if (existing.rows[0]) return res.status(400).json({ error: 'Subdomain already taken' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const clinicId = uuidv4();
    const subdomain = `${slug}.${process.env.BASE_DOMAIN}`;

    // Create clinic
    await client.query(`
      INSERT INTO clinics (id, name, slug, subdomain, email, phone, vet_name,
        address1, city, state, zip_code, template, brand_color, logo_url, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
    `, [clinicId, clinicName, slug, subdomain, email, phone, vetName,
        address1, city, state, zipCode, template || 'light', brandColor || '#2563EB', logoUrl || null]);

    // Create clinic admin user
    await client.query(`
      INSERT INTO clinic_users (clinic_id, email, password_hash, role)
      VALUES ($1,$2,$3,'admin')
    `, [clinicId, email, passwordHash]);

    // Auto-add all products as visible with default markup
    await client.query(`
      INSERT INTO clinic_products (clinic_id, product_id, is_visible, is_featured, markup_price)
      SELECT $1, id, TRUE, FALSE, unit_price * 1.6
      FROM products WHERE item_status != 'Discontinued'
    `, [clinicId]);

    await client.query('COMMIT');

    // Notify JP
    await sendEmail({
      toEmail: process.env.ADMIN_EMAIL,
      type: 'new_clinic_signup',
      data: { clinicName, subdomain, email, vetName }
    });

    res.json({ success: true, clinicId, subdomain, message: 'Account created — pending approval' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── CLINIC LOGIN ──────────────────────────────────────────────────────────────
router.post('/clinic/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query(`
    SELECT cu.*, cl.name AS clinic_name, cl.slug, cl.id AS clinic_id, cl.status AS clinic_status
    FROM clinic_users cu
    JOIN clinics cl ON cl.id = cu.clinic_id
    WHERE cu.email = $1
  `, [email]);

  const user = rows[0];
  if (!user || !await bcrypt.compare(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.clinic_status !== 'active') {
    return res.status(403).json({ error: 'Clinic account pending approval' });
  }

  const token = signToken({
    id: user.id, email: user.email,
    role: `clinic_${user.role}`,
    clinicId: user.clinic_id, clinicSlug: user.slug,
    clinicName: user.clinic_name
  });
  res.json({ token, user: { id: user.id, email: user.email, clinicId: user.clinic_id, clinicSlug: user.slug } });
});

// ── PET OWNER REGISTER ────────────────────────────────────────────────────────
router.post('/customer/register', async (req, res) => {
  const { clinicSlug, email, password, firstName, lastName, phone } = req.body;

  const clinic = await pool.query('SELECT id FROM clinics WHERE slug = $1 AND status = $2', [clinicSlug, 'active']);
  if (!clinic.rows[0]) return res.status(404).json({ error: 'Clinic not found' });

  const existing = await pool.query(
    'SELECT id FROM customers WHERE clinic_id = $1 AND email = $2',
    [clinic.rows[0].id, email]
  );
  if (existing.rows[0]) return res.status(400).json({ error: 'Account already exists' });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query(`
    INSERT INTO customers (clinic_id, email, password_hash, first_name, last_name, phone)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, first_name, last_name
  `, [clinic.rows[0].id, email, passwordHash, firstName, lastName, phone]);

  const customer = rows[0];
  const token = signToken({ id: customer.id, email: customer.email, role: 'customer', clinicId: clinic.rows[0].id });

  // Welcome SMS
  if (phone) {
    await sendSMS({
      clinicId: clinic.rows[0].id, customerId: customer.id,
      toNumber: phone,
      body: `Welcome to ${clinicSlug}'s online pharmacy, ${firstName}! You'll receive a text here when Dr. prescribes a new medication for your pet. 🐾`,
      type: 'welcome'
    });
  }

  res.json({ token, user: customer });
});

// ── PET OWNER LOGIN ───────────────────────────────────────────────────────────
router.post('/customer/login', async (req, res) => {
  const { clinicSlug, email, password } = req.body;

  const clinic = await pool.query('SELECT id FROM clinics WHERE slug = $1', [clinicSlug]);
  if (!clinic.rows[0]) return res.status(404).json({ error: 'Clinic not found' });

  const { rows } = await pool.query(
    'SELECT * FROM customers WHERE clinic_id = $1 AND email = $2',
    [clinic.rows[0].id, email]
  );
  const customer = rows[0];
  if (!customer || !await bcrypt.compare(password, customer.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({
    id: customer.id, email: customer.email,
    role: 'customer', clinicId: clinic.rows[0].id
  });
  res.json({ token, user: { id: customer.id, email: customer.email, firstName: customer.first_name } });
});

// ── CREATE CUSTOMER (vet adds manually) ──────────────────────────────────────
router.post('/customer/create', async (req, res) => {
  const { clinicId, email, firstName, lastName, phone, sendWelcome } = req.body;
  const tempPassword = Math.random().toString(36).slice(-8);
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  const { rows } = await pool.query(`
    INSERT INTO customers (clinic_id, email, password_hash, first_name, last_name, phone)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (clinic_id, email) DO UPDATE SET
      first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, phone = EXCLUDED.phone
    RETURNING *
  `, [clinicId, email, passwordHash, firstName, lastName, phone]);

  const customer = rows[0];

  if (sendWelcome && phone) {
    const clinic = await pool.query('SELECT * FROM clinics WHERE id = $1', [clinicId]);
    await sendSMS({
      clinicId, customerId: customer.id,
      toNumber: phone,
      body: `Hi ${firstName}! ${clinic.rows[0]?.name} has set up your pharmacy account. Your temp password: ${tempPassword}\nLogin: ${clinic.rows[0]?.subdomain}/login`,
      type: 'account_created'
    });
  }

  res.json({ success: true, customer, tempPassword: sendWelcome ? tempPassword : undefined });
});

module.exports = router;
