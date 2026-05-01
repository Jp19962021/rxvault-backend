const twilio = require('twilio');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let twilioClient;
function getClient() {
  if (!twilioClient) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

/**
 * Send an SMS and log it to the database
 */
async function sendSMS({ clinicId, customerId, prescriptionId, orderId, toNumber, body, type }) {
  if (!toNumber) {
    console.warn('[SMS] No phone number — skipping');
    return null;
  }

  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  let twilioSid = null, status = 'queued', errorCode = null, errorMessage = null;

  try {
    const message = await getClient().messages.create({
      body,
      to: toNumber,
      from: fromNumber
    });
    twilioSid = message.sid;
    status = message.status;
  } catch (err) {
    console.error('[SMS Error]', err.message);
    status = 'failed';
    errorCode = err.code?.toString();
    errorMessage = err.message;
  }

  // Log regardless of success/failure
  const { rows } = await pool.query(`
    INSERT INTO sms_log (
      clinic_id, customer_id, prescription_id, order_id,
      to_number, from_number, body, type,
      twilio_sid, status, error_code, error_message
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *
  `, [clinicId, customerId, prescriptionId || null, orderId || null,
      toNumber, fromNumber, body, type,
      twilioSid, status, errorCode, errorMessage]);

  return rows[0];
}

/**
 * Send Rx-approved SMS with unique cart link
 */
async function sendRxApprovedSMS({ clinic, customer, pet, prescription, products }) {
  const token = prescription.cart_link_token;
  const cartUrl = `https://${clinic.slug}.${process.env.BASE_DOMAIN}/cart/${token}`;
  const productNames = products.map(p => p.product_title).join(' + ');

  const body = `Hi ${customer.first_name}! Dr. ${clinic.vet_name} approved ${pet.name}'s prescription for ${productNames}. Your cart is ready 🐾\n${cartUrl}`;

  return sendSMS({
    clinicId: clinic.id,
    customerId: customer.id,
    prescriptionId: prescription.id,
    toNumber: customer.phone,
    body,
    type: 'rx_approved'
  });
}

/**
 * Send refill reminder SMS
 */
async function sendRefillReminderSMS({ clinic, customer, pet, prescription, product, daysLeft }) {
  const token = prescription.cart_link_token;
  const cartUrl = `https://${clinic.slug}.${process.env.BASE_DOMAIN}/cart/${token}`;

  const body = `Hi ${customer.first_name}! ${pet.name}'s ${product.product_title} refill is due in ${daysLeft} days. Order now to avoid running out 💊\n${cartUrl}`;

  return sendSMS({
    clinicId: clinic.id,
    customerId: customer.id,
    prescriptionId: prescription.id,
    toNumber: customer.phone,
    body,
    type: 'refill_reminder'
  });
}

/**
 * Send autoship upcoming charge SMS
 */
async function sendAutoshipReminderSMS({ clinic, customer, order, daysUntilCharge }) {
  const body = `Hi ${customer.first_name}! Your AutoShip order from ${clinic.name} will be processed in ${daysUntilCharge} days. Reply SKIP to skip this order or visit your account to manage.`;

  return sendSMS({
    clinicId: clinic.id,
    customerId: customer.id,
    orderId: order.id,
    toNumber: customer.phone,
    body,
    type: 'autoship_reminder'
  });
}

module.exports = {
  sendSMS,
  sendRxApprovedSMS,
  sendRefillReminderSMS,
  sendAutoshipReminderSMS
};
