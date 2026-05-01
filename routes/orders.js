const router = require('express').Router();
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { submitOrder, getOrderStatus, buildPCPOrder } = require('../services/pcpService');
const { sendSMS } = require('../services/smsService');
const { sendEmail } = require('../services/emailService');
const { authMiddleware, clinicMiddleware, adminMiddleware } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── CREATE PAYMENT INTENT (Stripe) ───────────────────────────────────────────
router.post('/payment-intent', authMiddleware, async (req, res) => {
  try {
    const { items, clinicSlug } = req.body;
    const customerId = req.user.id;

    // Calculate total from clinic product prices
    const clinic = await pool.query('SELECT id FROM clinics WHERE slug = $1', [clinicSlug]);
    if (!clinic.rows[0]) return res.status(404).json({ error: 'Clinic not found' });
    const clinicId = clinic.rows[0].id;

    let subtotal = 0;
    for (const item of items) {
      const { rows } = await pool.query(`
        SELECT COALESCE(cp.markup_price, p.unit_price * 1.6) AS price
        FROM products p
        LEFT JOIN clinic_products cp ON cp.product_id = p.id AND cp.clinic_id = $1
        WHERE p.id = $2
      `, [clinicId, item.productId]);
      if (rows[0]) subtotal += rows[0].price * item.quantity;
    }

    const taxRate = 0.0975; // TODO: use TaxJar for state-accurate rates
    const tax = subtotal * taxRate;
    const shipping = subtotal >= 49 ? 0 : 9.99;
    const total = Math.round((subtotal + tax + shipping) * 100); // cents

    const paymentIntent = await stripe.paymentIntents.create({
      amount: total,
      currency: 'usd',
      metadata: { clinicSlug, customerId }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      subtotal, tax, shipping, total: total / 100
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PLACE ORDER (after Stripe payment succeeds) ───────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      clinicSlug, petId, items, address, shipMethod,
      paymentIntentId, isAutoship, autoshipDays
    } = req.body;
    const customerId = req.user.id;

    // Verify payment with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }

    // Get clinic
    const clinicRes = await client.query(
      'SELECT * FROM clinics WHERE slug = $1', [clinicSlug]
    );
    const clinic = clinicRes.rows[0];
    if (!clinic) throw new Error('Clinic not found');

    // Get customer + pet
    const customerRes = await client.query('SELECT * FROM customers WHERE id = $1', [customerId]);
    const customer = customerRes.rows[0];
    const petRes = await client.query('SELECT * FROM pets WHERE id = $1', [petId]);
    const pet = petRes.rows[0];

    // Calculate totals
    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const prodRes = await client.query(`
        SELECT p.*, COALESCE(cp.markup_price, p.unit_price * 1.6) AS selling_price
        FROM products p
        LEFT JOIN clinic_products cp ON cp.product_id = p.id AND cp.clinic_id = $1
        WHERE p.id = $2
      `, [clinic.id, item.productId]);
      const product = prodRes.rows[0];

      const rxRes = await client.query(
        'SELECT * FROM prescriptions WHERE id = $1 AND status = $2',
        [item.prescriptionId, 'approved']
      );

      subtotal += product.selling_price * item.quantity;
      orderItems.push({
        product, prescription: rxRes.rows[0],
        quantity: item.quantity, unitPrice: product.selling_price,
        pcpUnitPrice: product.unit_price, instructions: item.instructions
      });
    }

    const tax = subtotal * 0.0975;
    const shipping = subtotal >= 49 ? 0 : 9.99;
    const total = subtotal + tax + shipping;
    const orderId = uuidv4();

    // Create order in DB
    await client.query(`
      INSERT INTO orders (
        id, clinic_id, customer_id, pet_id, status, ship_method,
        address1, address2, city, state, zip_code,
        stripe_payment_intent_id, subtotal, tax, shipping_cost, total,
        is_autoship, autoship_interval_days,
        next_autoship_at
      ) VALUES ($1,$2,$3,$4,'processing',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `, [
      orderId, clinic.id, customerId, petId, shipMethod || 'STANDARD',
      address.address1, address.address2 || '', address.city,
      address.state, address.zipCode,
      paymentIntentId, subtotal, tax, shipping, total,
      isAutoship || false, autoshipDays || 30,
      isAutoship ? new Date(Date.now() + (autoshipDays || 30) * 86400000) : null
    ]);

    // Create order items
    for (const item of orderItems) {
      await client.query(`
        INSERT INTO order_items (order_id, prescription_id, product_id, sku,
          product_title, quantity, unit_price, pcp_unit_price, instructions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        orderId, item.prescription?.id, item.product.id, item.product.item_sku,
        item.product.product_title, item.quantity, item.unitPrice,
        item.pcpUnitPrice, item.instructions || ''
      ]);
    }

    // Submit to PCP
    const pcpPayload = buildPCPOrder({
      internalOrder: { id: orderId, shipMethod: shipMethod || 'STANDARD', ...address },
      customer, pet, clinic,
      items: orderItems.map(i => ({
        sku: i.product.item_sku,
        productTitle: i.product.product_title,
        quantity: i.quantity,
        unitPrice: i.pcpUnitPrice,
        instructions: i.instructions,
        refillNumber: i.prescription?.refill_number || '0',
        isRefill: i.prescription?.is_refill || false,
        medicalDescription: pet.medical_notes || ''
      }))
    });

    let pcpOrderId = null;
    try {
      const pcpResult = await submitOrder(pcpPayload);
      pcpOrderId = pcpResult?.orderID || orderId;
      await client.query(
        'UPDATE orders SET pcp_order_id = $1, pcp_submitted_at = NOW(), status = $2 WHERE id = $3',
        [pcpOrderId, 'submitted_to_pcp', orderId]
      );
    } catch (pcpErr) {
      console.error('[PCP Submit Error]', pcpErr.message);
      // Don't fail the order — flag for manual retry
      await client.query(
        'UPDATE orders SET status = $1 WHERE id = $2',
        ['pcp_pending_retry', orderId]
      );
    }

    // Update clinic revenue
    await client.query(`
      UPDATE clinics SET
        total_revenue = total_revenue + $1,
        total_orders = total_orders + 1
      WHERE id = $2
    `, [total, clinic.id]);

    await client.query('COMMIT');

    // ── Post-order notifications ───────────────────────────────────────────
    // SMS confirmation
    await sendSMS({
      clinicId: clinic.id, customerId,
      toNumber: customer.phone,
      body: `✅ Order confirmed! Your medications are being prepared. Order #${orderId.slice(0,8).toUpperCase()}. We'll text you your tracking number when it ships. – ${clinic.name}`,
      type: 'order_confirmed',
      orderId
    });

    // Email confirmation
    await sendEmail({
      clinicId: clinic.id, customerId,
      toEmail: customer.email,
      type: 'order_confirmed',
      data: { order: { id: orderId, total }, clinic, customer }
    });

    res.json({ success: true, orderId, pcpOrderId, total });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Order Error]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET ORDER STATUS (polls PCP for tracking) ────────────────────────────────
router.get('/:orderId/status', authMiddleware, async (req, res) => {
  const { orderId } = req.params;
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Poll PCP if we have a PCP order ID and no tracking yet
  if (order.pcp_order_id && !order.tracking_number) {
    try {
      const pcpStatus = await getOrderStatus(order.pcp_order_id);
      if (pcpStatus.trackingNumber) {
        await pool.query(`
          UPDATE orders SET
            tracking_number = $1, carrier = $2,
            ship_date = $3, status = 'shipped', updated_at = NOW()
          WHERE id = $4
        `, [pcpStatus.trackingNumber, pcpStatus.carrier, pcpStatus.shipDate, orderId]);

        order.tracking_number = pcpStatus.trackingNumber;
        order.carrier = pcpStatus.carrier;
        order.status = 'shipped';

        // SMS tracking notification
        const customer = await pool.query('SELECT * FROM customers WHERE id = $1', [order.customer_id]);
        const clinic = await pool.query('SELECT * FROM clinics WHERE id = $1', [order.clinic_id]);
        if (customer.rows[0]?.phone) {
          await sendSMS({
            clinicId: order.clinic_id, customerId: order.customer_id,
            toNumber: customer.rows[0].phone,
            body: `📦 Your order shipped! Tracking: ${pcpStatus.trackingNumber} (${pcpStatus.carrier}). Est. delivery 3-5 days. – ${clinic.rows[0]?.name}`,
            type: 'shipping', orderId
          });
        }
      }
    } catch (e) {
      console.error('[PCP Status Poll Error]', e.message);
    }
  }

  res.json(order);
});

// ── GET CLINIC ORDERS ─────────────────────────────────────────────────────────
router.get('/clinic/:clinicId', clinicMiddleware, async (req, res) => {
  const { clinicId } = req.params;
  const { status, page = 1, limit = 25 } = req.query;
  const offset = (page - 1) * limit;

  let where = ['o.clinic_id = $1'];
  let params = [clinicId];
  if (status) { where.push(`o.status = $2`); params.push(status); }

  const { rows } = await pool.query(`
    SELECT
      o.*,
      c.first_name || ' ' || c.last_name AS customer_name,
      c.phone AS customer_phone,
      p.name AS pet_name,
      json_agg(json_build_object(
        'productTitle', oi.product_title,
        'quantity', oi.quantity,
        'unitPrice', oi.unit_price,
        'sku', oi.sku
      )) AS items
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN pets p ON p.id = o.pet_id
    JOIN order_items oi ON oi.order_id = o.id
    WHERE ${where.join(' AND ')}
    GROUP BY o.id, c.first_name, c.last_name, c.phone, p.name
    ORDER BY o.created_at DESC
    LIMIT $${params.length+1} OFFSET $${params.length+2}
  `, [...params, limit, offset]);

  res.json(rows);
});

// ── GET ALL ORDERS (admin) ────────────────────────────────────────────────────
router.get('/', adminMiddleware, async (req, res) => {
  const { page = 1, limit = 50, status } = req.query;
  const offset = (page - 1) * limit;
  let where = status ? `WHERE o.status = $3` : '';
  let params = [limit, offset];
  if (status) params.push(status);

  const { rows } = await pool.query(`
    SELECT o.*, cl.name AS clinic_name,
      c.first_name || ' ' || c.last_name AS customer_name
    FROM orders o
    JOIN clinics cl ON cl.id = o.clinic_id
    JOIN customers c ON c.id = o.customer_id
    ${where}
    ORDER BY o.created_at DESC LIMIT $1 OFFSET $2
  `, params);
  res.json(rows);
});

module.exports = router;
