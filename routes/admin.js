const router = require('express').Router();
const { Pool } = require('pg');
const pool = new Pool();

// GET platform stats
router.get('/stats', async (req, res) => {
  try {
    const [clinics, orders, customers, sms] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='active') as active FROM clinics`),
      pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(total),0) as revenue FROM orders WHERE created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) as total FROM customers`),
      pool.query(`SELECT COUNT(*) as total FROM sms_log WHERE sent_at > NOW() - INTERVAL '30 days'`)
    ]);
    res.json({
      clinics: clinics.rows[0],
      orders: orders.rows[0],
      customers: customers.rows[0],
      sms: sms.rows[0]
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
