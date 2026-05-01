const router = require('express').Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// GET all clinics (admin)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clinics ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single clinic by slug
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clinics WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Clinic not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH update clinic (branding, settings)
router.patch('/:clinicId', async (req, res) => {
  try {
    const fields = req.body;
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE clinics SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.clinicId, ...values]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH approve clinic (admin)
router.patch('/:clinicId/approve', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE clinics SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.clinicId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
