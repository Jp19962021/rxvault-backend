const router = require('express').Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// GET SMS log for a clinic
router.get('/clinic/:clinicId', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const { rows } = await pool.query(
      `SELECT s.*, c.first_name || ' ' || c.last_name AS customer_name
       FROM sms_log s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.clinic_id = $1
       ORDER BY s.sent_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.clinicId, limit, offset]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET full platform SMS log (admin)
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    const { rows } = await pool.query(
      `SELECT s.*, cl.name AS clinic_name, c.first_name || ' ' || c.last_name AS customer_name
       FROM sms_log s
       LEFT JOIN clinics cl ON cl.id = s.clinic_id
       LEFT JOIN customers c ON c.id = s.customer_id
       ORDER BY s.sent_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
