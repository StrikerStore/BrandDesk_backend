const express = require('express');
const { getBrands } = require('../config/brands');

const router = express.Router();

router.get('/', (req, res) => {
  const brands = getBrands().map(b => ({
    name: b.name,
    email: b.email,
    label: b.label,
    hasShopify: !!(b.shopifyStore && b.shopifyToken),
    // Booleans only — the credentials themselves never leave the server.
    hasPayu: !!(b.payuClientId && b.payuClientSecret),
  }));
  res.json(brands);
});

module.exports = router;
