const router = require('express').Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// GET pets for a customer
router.get('/customer/:customerId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM pets WHERE customer_id = $1 ORDER BY created_at DESC',
      [req.params.customerId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create pet
router.post('/', async (req, res) => {
  try {
    const { customerId, clinicId, name, species, breed, birthDate, gender, weight, medicalNotes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO pets (customer_id, clinic_id, name, species, breed, birth_date, gender, weight, medical_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [customerId, clinicId, name, species, breed || null, birthDate || null, gender || null, weight || null, medicalNotes || null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH update pet
router.patch('/:petId', async (req, res) => {
  try {
    const { name, species, breed, gender, weight, medicalNotes } = req.body;
    const { rows } = await pool.query(
      `UPDATE pets SET
        name         = COALESCE($1, name),
        species      = COALESCE($2, species),
        breed        = COALESCE($3, breed),
        gender       = COALESCE($4, gender),
        weight       = COALESCE($5, weight),
        medical_notes= COALESCE($6, medical_notes)
       WHERE id = $7 RETURNING *`,
      [name, species, breed, gender, weight, medicalNotes, req.params.petId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
