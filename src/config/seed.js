require('dotenv').config();
const db = require('./db');

const templates = [
  // Shipping
  { title: 'Order in transit', category: 'Shipping', body: 'Hi {{customer_name}},\n\nYour order {{order_id}} is currently in transit. You can track it here: {{tracking_link}}.\n\nExpected delivery in 1–2 business days. Please let us know if you have any questions!\n\nWarm regards,\n{{brand}} Support' },
  { title: 'Shipping delay apology', category: 'Shipping', body: 'Hi {{customer_name}},\n\nWe sincerely apologise for the delay with your order {{order_id}}. Due to high courier volume, your order has been delayed by 1–2 days.\n\nWe are actively monitoring the shipment and will update you as soon as it is on its way.\n\nSorry for the inconvenience!\n\n{{brand}} Support' },
  { title: 'Tracking link', category: 'Shipping', body: 'Hi {{customer_name}},\n\nHere is the tracking link for your order {{order_id}}: {{tracking_link}}\n\nYou can use this to check real-time delivery status. Feel free to reach out if you need anything else!\n\n{{brand}} Support' },
  { title: 'Order dispatched', category: 'Shipping', body: 'Hi {{customer_name}},\n\nGreat news — your order {{order_id}} has been dispatched and is on its way to you!\n\nTracking details: {{tracking_link}}\n\nExpected delivery: 2–4 business days.\n\n{{brand}} Support' },

  // Refunds
  { title: 'Refund initiated', category: 'Refunds', body: 'Hi {{customer_name}},\n\nWe have initiated a refund of {{amount}} for order {{order_id}} to your original payment method.\n\nRefunds typically reflect within 5–7 business days depending on your bank.\n\nWe are sorry it did not work out this time — please do not hesitate to reach out if you need anything.\n\n{{brand}} Support' },
  { title: 'Refund policy info', category: 'Refunds', body: 'Hi {{customer_name}},\n\nThank you for reaching out. Our return and refund policy allows returns within 14 days of delivery for unused items in original packaging.\n\nOnce we receive the return, a refund is processed within 3–5 business days.\n\nPlease reply with your order ID and reason for return and we will get the process started!\n\n{{brand}} Support' },
  { title: 'Refund not eligible', category: 'Refunds', body: 'Hi {{customer_name}},\n\nThank you for getting in touch about order {{order_id}}. Unfortunately, this order does not qualify for a refund as it falls outside our 14-day return window.\n\nHowever, we would love to help in other ways — please let us know if we can assist further.\n\n{{brand}} Support' },

  // Exchanges
  { title: 'Exchange request accepted', category: 'Exchanges', body: 'Hi {{customer_name}},\n\nWe have accepted your exchange request for order {{order_id}}. Our team will arrange a pickup of the original item and dispatch the replacement within 2 business days.\n\nYou will receive a confirmation email with pickup details shortly.\n\n{{brand}} Support' },
  { title: 'Wrong item received', category: 'Exchanges', body: 'Hi {{customer_name}},\n\nWe are really sorry you received the wrong item in order {{order_id}} — that should not have happened!\n\nWe will arrange an immediate pickup and send the correct item at no extra cost. Could you please share a photo of the item you received? That will help us resolve this faster.\n\nSorry again for the trouble!\n\n{{brand}} Support' },

  // General
  { title: 'Acknowledgement', category: 'General', body: 'Hi {{customer_name}},\n\nThank you for reaching out to {{brand}} support! We have received your query and our team will get back to you within 24 hours.\n\nIn the meantime, feel free to reply to this email with any additional details.\n\n{{brand}} Support' },
  { title: 'Follow up', category: 'General', body: 'Hi {{customer_name}},\n\nWe wanted to follow up on your recent query regarding order {{order_id}}. Has everything been sorted out to your satisfaction?\n\nPlease let us know if there is anything else we can help with!\n\n{{brand}} Support' },
  { title: 'Issue resolved confirmation', category: 'General', body: 'Hi {{customer_name}},\n\nWe are glad to confirm that your issue regarding order {{order_id}} has been resolved.\n\nIf you have any further questions or concerns, do not hesitate to reach out. We are always happy to help!\n\nThank you for choosing {{brand}}.\n\n{{brand}} Support' },
  { title: 'Discount code not working', category: 'General', body: 'Hi {{customer_name}},\n\nSorry to hear your discount code is not working! This can sometimes happen if the code has expired or if the cart total does not meet the minimum requirement.\n\nCould you share the code you are trying to use? We will look into it right away and apply the discount manually if needed.\n\n{{brand}} Support' },
  { title: 'Out of stock notification', category: 'General', body: 'Hi {{customer_name}},\n\nThank you for your interest in this product! Unfortunately it is currently out of stock.\n\nWe expect to restock within 7–10 days. We will send you an email as soon as it is available again.\n\nSorry for the wait!\n\n{{brand}} Support' },
];

async function seed() {
  console.log('🌱 Seeding templates...');
  for (const t of templates) {
    await db.query(
      'INSERT IGNORE INTO templates (title, category, body) VALUES (?, ?, ?)',
      [t.title, t.category, t.body]
    );
  }
  console.log(`✅ Seeded ${templates.length} templates`);
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
