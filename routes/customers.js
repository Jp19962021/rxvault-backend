const router = require('express').Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// GET customers for a clinic
router.get('/clinic/:clinicId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(p.id) as pet_count
       FROM customers c
       LEFT JOIN pets p ON p.customer_id = c.id
       WHERE c.clinic_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [req.params.clinicId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single customer
router.get('/:customerId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.customerId]);
    if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH update customer
router.patch('/:customerId', async (req, res) => {
  try {
    const { firstName, lastName, phone, address1, address2, city, state, zipCode } = req.body;
    const { rows } = await pool.query(
      `UPDATE customers SET
        first_name = COALESCE($1, first_name),
        last_name  = COALESCE($2, last_name),
        phone      = COALESCE($3, phone),
        address1   = COALESCE($4, address1),
        address2   = COALESCE($5, address2),
        city       = COALESCE($6, city),
        state      = COALESCE($7, state),
        zip_code   = COALESCE($8, zip_code),
        updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [firstName, lastName, phone, address1, address2, city, state, zipCode, req.params.customerId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
