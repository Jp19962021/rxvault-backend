const router = require('express').Router();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const { sendRxApprovedSMS } = require('../services/smsService');
const { authMiddleware, clinicMiddleware } = require('../middleware/auth');

const pool = new Pool();

// ── GET PENDING Rx FOR CLINIC ─────────────────────────────────────────────────
router.get('/clinic/:clinicId/pending', clinicMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      rx.*,
      c.first_name || ' ' || c.last_name AS customer_name,
      c.phone AS customer_phone,
      c.email AS customer_email,
      p.name AS pet_name, p.species, p.breed, p.weight,
      pr.product_title, pr.item_sku, pr.image_url,
      COALESCE(cp.markup_price, pr.unit_price * 1.6) AS selling_price
    FROM prescriptions rx
    JOIN customers c ON c.id = rx.customer_id
    JOIN pets p ON p.id = rx.pet_id
    JOIN products pr ON pr.id = rx.product_id
    LEFT JOIN clinic_products cp ON cp.product_id = rx.product_id AND cp.clinic_id = rx.clinic_id
    WHERE rx.clinic_id = $1 AND rx.status = 'pending'
    ORDER BY rx.created_at ASC
  `, [req.params.clinicId]);
  res.json(rows);
});

// ── APPROVE Rx → GENERATE CART TOKEN → SEND SMS ───────────────────────────────
router.post('/:prescriptionId/approve', clinicMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { prescriptionId } = req.params;
    const { refillsRemaining, instructions, approvedBy } = req.body;

    // Generate unique cart token
    const cartToken = uuidv4();

    const { rows } = await client.query(`
      UPDATE prescriptions SET
        status = 'approved',
        refills_remaining = $1,
        instructions = $2,
        approved_by = $3,
        approved_at = NOW(),
        cart_link_token = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [refillsRemaining || 10, instructions || '', approvedBy, cartToken, prescriptionId]);

    const prescription = rows[0];
    if (!prescription) throw new Error('Prescription not found');

    // Fetch related data for SMS
    const [clinicRes, customerRes, petRes, productRes] = await Promise.all([
      client.query('SELECT * FROM clinics WHERE id = $1', [prescription.clinic_id]),
      client.query('SELECT * FROM customers WHERE id = $1', [prescription.customer_id]),
      client.query('SELECT * FROM pets WHERE id = $1', [prescription.pet_id]),
      client.query('SELECT * FROM products WHERE id = $1', [prescription.product_id])
    ]);

    const clinic = clinicRes.rows[0];
    const customer = customerRes.rows[0];
    const pet = petRes.rows[0];
    const product = productRes.rows[0];

    await client.query('COMMIT');

    // Send SMS (outside transaction)
    let smsResult = null;
    if (customer.phone && customer.sms_opt_in) {
      smsResult = await sendRxApprovedSMS({
        clinic, customer, pet, prescription, products: [product]
      });
      // Log SMS sent time
      await pool.query(
        'UPDATE prescriptions SET sms_sent_at = NOW() WHERE id = $1',
        [prescriptionId]
      );
    }

    res.json({ success: true, prescription, cartToken, smsSent: !!smsResult });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DENY Rx ───────────────────────────────────────────────────────────────────
router.post('/:prescriptionId/deny', clinicMiddleware, async (req, res) => {
  const { reason } = req.body;
  const { rows } = await pool.query(`
    UPDATE prescriptions SET status = 'denied', instructions = $1, updated_at = NOW()
    WHERE id = $2 RETURNING *
  `, [reason || 'Denied by clinic', req.params.prescriptionId]);

  res.json(rows[0]);
});

// ── CREATE Rx (vet creates for a patient) ────────────────────────────────────
router.post('/', clinicMiddleware, async (req, res) => {
  const { clinicId, customerId, petId, productId, isRefill, instructions, medicalDescription } = req.body;

  const { rows } = await pool.query(`
    INSERT INTO prescriptions (clinic_id, customer_id, pet_id, product_id,
      is_refill, instructions, medical_description)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
  `, [clinicId, customerId, petId, productId, isRefill || false, instructions || '', medicalDescription || '']);

  res.json(rows[0]);
});

// ── GET CART BY TOKEN (pet owner taps SMS link) ───────────────────────────────
router.get('/cart/:token', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      rx.*,
      c.first_name || ' ' || c.last_name AS customer_name,
      c.email, c.phone, c.address1, c.address2, c.city, c.state, c.zip_code,
      p.name AS pet_name, p.species, p.breed,
      pr.product_title, pr.item_sku, pr.image_url, pr.prescription_required,
      pr.directions, pr.flavor, pr.unit_of_measure,
      cl.name AS clinic_name, cl.slug AS clinic_slug, cl.logo_url,
      cl.brand_color, cl.template, cl.vet_name,
      COALESCE(cp.markup_price, pr.unit_price * 1.6) AS price
    FROM prescriptions rx
    JOIN customers c ON c.id = rx.customer_id
    JOIN pets p ON p.id = rx.pet_id
    JOIN products pr ON pr.id = rx.product_id
    JOIN clinics cl ON cl.id = rx.clinic_id
    LEFT JOIN clinic_products cp ON cp.product_id = rx.product_id AND cp.clinic_id = rx.clinic_id
    WHERE rx.cart_link_token = $1 AND rx.status = 'approved'
  `, [req.params.token]);

  if (!rows[0]) return res.status(404).json({ error: 'Invalid or expired cart link' });
  res.json(rows[0]);
});

// ── GET ALL Rx FOR CUSTOMER ───────────────────────────────────────────────────
router.get('/customer/:customerId', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT rx.*, pr.product_title, pr.image_url, pr.item_sku,
      p.name AS pet_name,
      COALESCE(cp.markup_price, pr.unit_price * 1.6) AS price
    FROM prescriptions rx
    JOIN products pr ON pr.id = rx.product_id
    JOIN pets p ON p.id = rx.pet_id
    LEFT JOIN clinic_products cp ON cp.product_id = rx.product_id AND cp.clinic_id = rx.clinic_id
    WHERE rx.customer_id = $1 AND rx.status = 'approved'
    ORDER BY rx.approved_at DESC
  `, [req.params.customerId]);
  res.json(rows);
});

module.exports = router;
