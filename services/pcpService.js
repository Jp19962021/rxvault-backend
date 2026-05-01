const axios = require('axios');

const PCP_BASE = process.env.PCP_BASE_URL || 'https://pcpfulfillment.azurewebsites.net';
const PARTNER_ID = process.env.PCP_PARTNER_ID;

const pcpClient = axios.create({
  baseURL: PCP_BASE,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

// ── Logging interceptor ─────────────────────────────────────────────────────
pcpClient.interceptors.response.use(
  res => res,
  err => {
    console.error('[PCP API Error]', err.response?.status, err.response?.data);
    throw err;
  }
);

// ── PRODUCTS ─────────────────────────────────────────────────────────────────

/**
 * GET /api/Product/list
 * Returns array of { itemSku, productTitle }
 */
async function getProductList() {
  const res = await pcpClient.get('/api/Product/list', {
    params: { partnerId: PARTNER_ID }
  });
  return res.data; // ProductSummary[]
}

/**
 * GET /api/Product
 * Returns full PCPProduct for a given SKU
 */
async function getProduct(itemNumber) {
  const res = await pcpClient.get('/api/Product', {
    params: { partnerId: PARTNER_ID, itemNumber }
  });
  return res.data; // PCPProduct
}

// ── ORDERS ────────────────────────────────────────────────────────────────────

/**
 * POST /api/Order
 * Submit a fulfilled order to PCP for compounding + shipping
 *
 * @param {Object} order - matches PCP Order schema
 * @param {string} order.orderNumber
 * @param {string} order.orderDate - ISO datetime
 * @param {string} order.shipMethod - e.g. "STANDARD", "EXPEDITED"
 * @param {string} order.shipToName
 * @param {string} order.shipToAddress1
 * @param {string} order.shipToAddress2
 * @param {string} order.shipToCity
 * @param {string} order.shipToState
 * @param {string} order.shipToZipCode
 * @param {string} order.shipToPhone
 * @param {Array}  order.details - array of Detail objects
 */
async function submitOrder(order) {
  const res = await pcpClient.post('/api/Order', order, {
    params: { partnerId: PARTNER_ID }
  });
  return res.data;
}

/**
 * GET /api/Order
 * Check order status — returns tracking number, ship date, carrier
 */
async function getOrderStatus(orderId) {
  const res = await pcpClient.get('/api/Order', {
    params: { partnerId: PARTNER_ID, OrderId: orderId }
  });
  return res.data; // PCPOrder
}

/**
 * POST /api/VTEX
 * Sync a VTEX order number (used as webhook trigger)
 */
async function syncVtexOrder(orderNumber) {
  const res = await pcpClient.post('/api/VTEX', null, {
    params: { partnerId: PARTNER_ID, OrderNumber: orderNumber }
  });
  return res.data;
}

// ── ORDER BUILDER ─────────────────────────────────────────────────────────────

/**
 * Build a PCP-formatted order from our internal order data
 */
function buildPCPOrder({ internalOrder, customer, pet, clinic, items }) {
  return {
    orderNumber: internalOrder.id,
    orderDate: new Date().toISOString(),
    shipMethod: internalOrder.shipMethod || 'STANDARD',
    shipToName: `${customer.firstName} ${customer.lastName}`,
    shipToAddress1: internalOrder.address1,
    shipToAddress2: internalOrder.address2 || '',
    shipToCity: internalOrder.city,
    shipToState: internalOrder.state,
    shipToZipCode: internalOrder.zipCode,
    shipToPhone: customer.phone,
    details: items.map(item => ({
      sku: item.sku,
      title: item.productTitle,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      deliveryDate: null,
      productNotes: item.notes || '',
      givingInstructions: item.instructions || '',
      vetInfo: {
        clinicName: clinic.name,
        vetName: clinic.vetName,
        licenseId: clinic.licenseId,
        licenseState: clinic.licenseState,
        address1: clinic.address1,
        address2: clinic.address2 || '',
        city: clinic.city,
        state: clinic.state,
        zipCode: clinic.zipCode,
        faxOrMailScript: clinic.faxNumber || '',
        refillNumber: item.refillNumber || '0',
        newOrRefill: item.isRefill ? 'REFILL' : 'NEW',
        key: clinic.pcpKey || ''
      },
      petInfo: {
        petName: pet.name,
        type: pet.species,
        breed: pet.breed || '',
        birthDate: pet.birthDate || '',
        gender: pet.gender || '',
        weight: pet.weight || 0,
        ownerName: `${customer.firstName} ${customer.lastName}`,
        medicalDescription: item.medicalDescription || ''
      }
    }))
  };
}

module.exports = {
  getProductList,
  getProduct,
  submitOrder,
  getOrderStatus,
  syncVtexOrder,
  buildPCPOrder
};
