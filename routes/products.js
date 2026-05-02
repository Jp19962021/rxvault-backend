const router = require('express').Router();
const { Pool } = require('pg');
const { getProductList, getProduct } = require('../services/pcpService');
const { authMiddleware, adminMiddleware, clinicMiddleware } = require('../middleware/auth');

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

// ── SYNC PRODUCTS FROM PCP ────────────────────────────────────────────────────
// Called by cron job nightly OR manually from admin panel
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL PRODUCTS (admin) ──────────────────────────────────────────────────
router.get('/', adminMiddleware, async (req, res) => {
  const { search, animalType, prescriptionRequired, page = 1, limit = 50 } = req.query;
  let where = ['item_status != $1'];
  let params = ['Discontinued'];
  let idx = 2;

  if (search) { where.push(`(product_title ILIKE $${idx} OR keywords ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
  if (animalType) { where.push(`animal_type ILIKE $${idx}`); params.push(`%${animalType}%`); idx++; }
  if (prescriptionRequired !== undefined) { where.push(`prescription_required = $${idx}`); params.push(prescriptionRequired === 'true'); idx++; }

  const offset = (page - 1) * limit;
  const { rows } = await pool.query(`
    SELECT * FROM products WHERE ${where.join(' AND ')}
    ORDER BY product_title ASC LIMIT $${idx} OFFSET $${idx+1}
  `, [...params, limit, offset]);

  res.json(rows);
});

// ── GET CLINIC PRODUCTS (with clinic markup + visibility) ─────────────────────
router.get('/clinic/:clinicId', clinicMiddleware, async (req, res) => {
  const { clinicId } = req.params;
  const { search, category, featured, page = 1, limit = 50 } = req.query;

  let where = [`p.item_status != 'Discontinued'`];
  let params = [clinicId];
  let idx = 2;

  if (search) { where.push(`(p.product_title ILIKE $${idx} OR p.keywords ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
  if (category) { where.push(`p.product_type ILIKE $${idx}`); params.push(`%${category}%`); idx++; }
  if (featured === 'true') { where.push(`cp.is_featured = TRUE`); }

  const offset = (page - 1) * limit;
  const { rows } = await pool.query(`
    SELECT
      p.*,
      cp.is_visible,
      cp.is_featured,
      cp.markup_price,
      COALESCE(cp.markup_price, p.unit_price * 1.6) AS selling_price
    FROM products p
    LEFT JOIN clinic_products cp ON cp.product_id = p.id AND cp.clinic_id = $1
    WHERE ${where.join(' AND ')}
    ORDER BY cp.is_featured DESC NULLS LAST, p.product_title ASC
    LIMIT $${idx} OFFSET $${idx+1}
  `, [...params, limit, offset]);

  res.json(rows);
});

// ── GET STOREFRONT PRODUCTS (public — visible only) ───────────────────────────
router.get('/storefront/:clinicSlug', async (req, res) => {
  const { clinicSlug } = req.params;
  const { search, animalType, category, featured } = req.query;

  const clinic = await pool.query('SELECT id FROM clinics WHERE slug = $1 AND status = $2', [clinicSlug, 'active']);
  if (!clinic.rows[0]) return res.status(404).json({ error: 'Clinic not found' });

  const clinicId = clinic.rows[0].id;
  let where = [`p.item_status != 'Discontinued'`, `(cp.is_visible = TRUE OR cp.is_visible IS NULL)`];
  let params = [clinicId];
  let idx = 2;

  if (search) { where.push(`(p.product_title ILIKE $${idx} OR p.keywords ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
  if (animalType) { where.push(`p.animal_type ILIKE $${idx}`); params.push(`%${animalType}%`); idx++; }
  if (category) { where.push(`p.product_type ILIKE $${idx}`); params.push(`%${category}%`); idx++; }
  if (featured === 'true') { where.push(`cp.is_featured = TRUE`); }

  const { rows } = await pool.query(`
    SELECT
      p.id, p.item_sku, p.product_title, p.product_name, p.animal_type,
      p.product_type, p.prescription_required, p.image_url, p.image_urls,
      p.bullet_points, p.product_long_desc, p.flavor, p.unit_of_measure,
      p.sku_size, p.sku_count, p.quantity_available,
      cp.is_featured,
      COALESCE(cp.markup_price, p.unit_price * 1.6) AS price
    FROM products p
    LEFT JOIN clinic_products cp ON cp.product_id = p.id AND cp.clinic_id = $1
    WHERE ${where.join(' AND ')}
    ORDER BY cp.is_featured DESC NULLS LAST, p.product_title ASC
    LIMIT 100
  `, params);

  res.json(rows);
});

// ── UPDATE CLINIC PRODUCT (toggle, price, star) ───────────────────────────────
router.patch('/clinic/:clinicId/:productId', clinicMiddleware, async (req, res) => {
  const { clinicId, productId } = req.params;
  const { isVisible, isFeatured, markupPrice } = req.body;

  const { rows } = await pool.query(`
    INSERT INTO clinic_products (clinic_id, product_id, is_visible, is_featured, markup_price)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (clinic_id, product_id) DO UPDATE SET
      is_visible   = COALESCE($3, clinic_products.is_visible),
      is_featured  = COALESCE($4, clinic_products.is_featured),
      markup_price = COALESCE($5, clinic_products.markup_price),
      updated_at   = NOW()
    RETURNING *
  `, [clinicId, productId, isVisible, isFeatured, markupPrice]);

  res.json(rows[0]);
});

module.exports = router;

