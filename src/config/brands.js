require('dotenv').config();

function getBrands() {
  const raw = process.env.BRANDS || '';
  if (!raw) return [];

  return raw.split(',').map(entry => {
    const [label, email, ...nameParts] = entry.trim().split(':');
    return {
      label: label.trim(),
      email: email.trim(),
      name: nameParts.join(':').trim(),
      shopifyStore: process.env['SHOPIFY_' + label.replace(/-/g, '_').toUpperCase() + '_STORE'],
      shopifyToken: process.env['SHOPIFY_' + label.replace(/-/g, '_').toUpperCase() + '_TOKEN'],
    };
  }).filter(b => b.label && b.email && b.name);
}

function getBrandByLabel(label) {
  return getBrands().find(b => b.label === label) || null;
}

function getBrandByEmail(email) {
  return getBrands().find(b => b.email === email) || null;
}

function getBrandByName(name) {
  return getBrands().find(b => b.name === name) || null;
}

module.exports = { getBrands, getBrandByLabel, getBrandByEmail, getBrandByName };
