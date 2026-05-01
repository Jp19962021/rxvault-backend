const cron = require('node-cron');
const { Pool } = require('pg');
const axios = require('axios');
const { getOrderStatus } = require('./services/pcpService');
const { sendRefillReminderSMS, sendAutoshipReminderSMS } = require('./services/smsService');
const { sendEmail } = require('./services/emailService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── NIGHTLY PRODUCT SYNC (2am) ────────────────────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Starting nightly PCP product sync...');
  try {
    await axios.post(`http://localhost:${process.env.PORT}/api/products/sync`,
      {}, { headers: { Authorization: `Bearer ${process.env.INTERNAL_CRON_TOKEN}` } }
    );
    console.log('[CRON] Product sync complete');
  } catch (err) {
    console.error('[CRON] Product sync failed:', err.message);
  }
});

// ── ORDER STATUS POLLING (every 2 hours) ──────────────────────────────────────
cron.schedule('0 */2 * * *', async () => {
  console.log('[CRON] Polling PCP for order updates...');
  const { rows: orders } = await pool.query(`
    SELECT o.*, c.phone, c.first_name, cl.name AS clinic_name, cl.id AS clinic_id
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN clinics cl ON cl.id = o.clinic_id
    WHERE o.status = 'submitted_to_pcp' AND o.pcp_order_id IS NOT NULL
    AND o.tracking_number IS NULL
  `);

  for (const order of orders) {
    try {
      const status = await getOrderStatus(order.pcp_order_id);
      if (status.trackingNumber) {
        await pool.query(`
          UPDATE orders SET tracking_number=$1, carrier=$2, ship_date=$3, status='shipped'
          WHERE id=$4
        `, [status.trackingNumber, status.carrier, status.shipDate, order.id]);

        if (order.phone) {
          await sendSMSDirect(order.clinic_id, order.id, order.phone,
            `📦 Your order from ${order.clinic_name} has shipped! Tracking: ${status.trackingNumber} (${status.carrier})`
          );
        }
        console.log(`[CRON] Order ${order.id} shipped: ${status.trackingNumber}`);
      }
    } catch (e) {
      console.error(`[CRON] Status poll failed for ${order.id}:`, e.message);
    }
  }
});

// ── REFILL REMINDERS (9am daily) ─────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('[CRON] Sending refill reminders...');

  // Find prescriptions where patient likely running low (based on last order + supply days)
  const { rows } = await pool.query(`
    SELECT rx.*, c.first_name, c.phone, c.email, c.sms_opt_in,
      p.name AS pet_name, pr.product_title,
      cl.name AS clinic_name, cl.slug AS clinic_slug, cl.id AS clinic_id,
      oi.quantity, pr.unit_of_measure
    FROM prescriptions rx
    JOIN customers c ON c.id = rx.customer_id
    JOIN pets p ON p.id = rx.pet_id
    JOIN products pr ON pr.id = rx.product_id
    JOIN clinics cl ON cl.id = rx.clinic_id
    JOIN order_items oi ON oi.prescription_id = rx.id
    JOIN orders o ON o.id = oi.order_id
    WHERE rx.status = 'approved'
    AND rx.refills_remaining > 0
    AND o.created_at < NOW() - INTERVAL '23 days'
    AND o.created_at > NOW() - INTERVAL '25 days'
    AND NOT EXISTS (
      SELECT 1 FROM orders o2
      JOIN order_items oi2 ON oi2.order_id = o2.id
      WHERE oi2.prescription_id = rx.id
      AND o2.created_at > NOW() - INTERVAL '7 days'
    )
  `);

  for (const row of rows) {
    if (row.sms_opt_in && row.phone) {
      await sendRefillReminderSMS({
        clinic: { id: row.clinic_id, name: row.clinic_name, slug: row.clinic_slug },
        customer: { id: row.customer_id, first_name: row.first_name, phone: row.phone },
        pet: { name: row.pet_name },
        prescription: { id: row.id, cart_link_token: row.cart_link_token },
        product: { product_title: row.product_title },
        daysLeft: 7
      });
    }
  }
  console.log(`[CRON] Sent ${rows.length} refill reminders`);
});

// ── AUTOSHIP PROCESSING (8am daily) ──────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Processing autoship orders...');

  // Send 3-day warnings
  const { rows: upcoming } = await pool.query(`
    SELECT a.*, c.first_name, c.phone, cl.name AS clinic_name
    FROM autoship_subscriptions a
    JOIN customers c ON c.id = a.customer_id
    JOIN clinics cl ON cl.id = a.clinic_id
    WHERE a.status = 'active'
    AND a.next_order_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
  `);

  for (const sub of upcoming) {
    if (sub.phone) {
      await sendAutoshipReminderSMS({
        clinic: { id: sub.clinic_id, name: sub.clinic_name },
        customer: { id: sub.customer_id, first_name: sub.first_name, phone: sub.phone },
        order: { id: sub.id },
        daysUntilCharge: 3
      });
    }
  }

  console.log(`[CRON] Autoship: ${upcoming.length} reminders sent`);
});

async function sendSMSDirect(clinicId, orderId, phone, body) {
  const { sendSMS } = require('./services/smsService');
  await sendSMS({ clinicId, orderId, toNumber: phone, body, type: 'shipping' });
}

console.log('[CRON] All jobs scheduled');
module.exports = {};
