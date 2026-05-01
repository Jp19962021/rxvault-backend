const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── KLAVIYO ───────────────────────────────────────────────────────────────────
async function sendKlaviyoEmail({ toEmail, templateId, data }) {
  const res = await axios.post('https://a.klaviyo.com/api/events/', {
    data: {
      type: 'event',
      attributes: {
        profile: { data: { type: 'profile', attributes: { email: toEmail } } },
        metric: { data: { type: 'metric', attributes: { name: templateId } } },
        properties: data
      }
    }
  }, {
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      revision: '2023-12-15',
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

// ── OMNISEND ──────────────────────────────────────────────────────────────────
async function sendOmnisendEmail({ toEmail, templateId, data }) {
  const res = await axios.post('https://api.omnisend.com/v3/events', {
    email: toEmail,
    eventName: templateId,
    fields: data
  }, {
    headers: { 'X-API-KEY': process.env.OMNISEND_API_KEY }
  });
  return res.data;
}

// ── EVENT → TEMPLATE MAPPING ──────────────────────────────────────────────────
const EVENT_TEMPLATES = {
  welcome:            'Customer Welcome',
  rx_approved:        'Rx Approved - Cart Ready',
  order_confirmed:    'Order Confirmed',
  order_shipped:      'Order Shipped - Tracking',
  refill_reminder:    'Refill Reminder',
  autoship_reminder:  'AutoShip Upcoming',
  autoship_processed: 'AutoShip Processed',
  new_clinic_signup:  'New Clinic Signup - Admin Alert',
  account_created:    'Account Created'
};

// ── MAIN SEND FUNCTION ────────────────────────────────────────────────────────
async function sendEmail({ clinicId, customerId, toEmail, type, data, platform }) {
  const templateId = EVENT_TEMPLATES[type] || type;

  // Determine platform — clinic setting or default to Klaviyo
  let emailPlatform = platform;
  if (!emailPlatform && clinicId) {
    const { rows } = await pool.query('SELECT email_platform FROM clinics WHERE id = $1', [clinicId]);
    emailPlatform = rows[0]?.email_platform || 'klaviyo';
  }
  if (!emailPlatform) emailPlatform = 'klaviyo';

  let externalId = null;
  try {
    if (emailPlatform === 'omnisend') {
      const result = await sendOmnisendEmail({ toEmail, templateId, data });
      externalId = result?.id;
    } else {
      const result = await sendKlaviyoEmail({ toEmail, templateId, data });
      externalId = result?.data?.id;
    }
  } catch (err) {
    console.error(`[Email ${emailPlatform} Error]`, err.response?.data || err.message);
  }

  // Log
  if (clinicId || customerId) {
    await pool.query(`
      INSERT INTO email_log (clinic_id, customer_id, to_email, type, platform, external_id)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [clinicId || null, customerId || null, toEmail, type, emailPlatform, externalId]).catch(console.error);
  }

  return externalId;
}

module.exports = { sendEmail };
