require('dotenv').config();

function getBrands() {
  const raw = process.env.BRANDS || '';
  if (!raw) return [];

  return raw.split(',').map(entry => {
    const [label, email, ...nameParts] = entry.trim().split(':');
    const key = label.replace(/-/g, '_').toUpperCase();
    return {
      label: label.trim(),
      email: email.trim(),
      name: nameParts.join(':').trim(),
      // The per-brand env-var infix. Exposed because real labels are long
      // ("customer-ticket-dribble-ticket"), so the derived names run to 45
      // characters and a typo is easy — error messages quote this back rather
      // than leaving you to reconstruct it by hand.
      envKey: key,
      shopifyStore: process.env['SHOPIFY_' + key + '_STORE'],
      shopifyToken: process.env['SHOPIFY_' + key + '_TOKEN'],
      // PayU OAuth credentials, same per-brand env convention as Shopify above.
      // "client token" is PayU's name for the OAuth client secret.
      payuClientId:     process.env['PAYU_' + key + '_CLIENT_ID'],
      payuClientSecret: process.env['PAYU_' + key + '_CLIENT_TOKEN'],
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
