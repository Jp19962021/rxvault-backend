const router = require('express').Router();
const { Pool } = require('pg');
const { getProductList } = require('../services/pcpService');
const { adminMiddleware, clinicMiddleware } = require('../middleware/auth');
const pool = new Pool();

router.post('/sync', adminMiddleware, async (req, res) => {
  res.json({ success: true, message: 'Sync started in background' });
  try {
    const list = await getProductList();
    let synced = 0, errors = 0;
    for (const item of list) {
      try {
        await pool.query(`
          INSERT INTO products (item_sku, product_title, product_name, brand_name, unit_price, msrp, prescription_required, animal_type, product_type, quantity_available, item_status, image_url, last_synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
          ON CONFLICT (item_sku) DO UPDATE SET
            product_title=EXCLUDED.product_title, unit_price=EXCLUDED.unit_price,
            msrp=EXCLUDED.msrp, quantity_available=EXCLUDED.quantity_available,
            item_status=EXCLUDED.item_status, image_url=EXCLUDED.image_url, last_synced_at=NOW()
        `, [item.itemSku, item.productTitle, item.productName, item.brandName,
            item.unitPrice, item.msrp, item.prescriptionRequired,
            item.animalType, item.productType, item.quantityAvailable,
            item.itemStatus, item.imageFileLink]);
        synced++;
      } catch(e) { errors++; }
    }
    console.log(`[Sync] Done: ${synced} synced, ${errors} errors`);
  } catch(err) { console.error('[Sync]', err.message); }
});

router.get('/clinic', clinicMiddleware, async (req, res) => {
  const { clinicId } = req.user;
  const { rows } = await pool.query(`
    SELECT p.*, cp.is_visible, cp.is_featured, cp.markup_price, cp.is_hidden
    FROM products p
    JOIN clinic_products cp ON cp.product_id = p.id
    WHERE cp.clinic_id = $1 AND cp.is_hidden = FALSE
    ORDER BY p.product_title
  `, [clinicId]);
  res.json(rows);
});

router.put('/clinic/:productId', clinicMiddleware, async (req, res) => {
  const { clinicId } = req.user;
  const { productId } = req.params;
  const { is_visible, is_featured, markup_price, is_hidden } = req.body;
  await pool.query(`
    UPDATE clinic_products SET
      is_visible = COALESCE($1, is_visible),
      is_featured = COALESCE($2, is_featured),
      markup_price = COALESCE($3, markup_price),
      is_hidden = COALESCE($4, is_hidden)
    WHERE clinic_id = $5 AND product_id = $6
  `, [is_visible, is_featured, markup_price, is_hidden, clinicId, productId]);
  res.json({ success: true });
});

router.get('/admin/all', adminMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY product_title');
  res.json(rows);
});

router.get('/:itemSku', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE item_sku = $1', [req.params.itemSku]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

module.exports = router;