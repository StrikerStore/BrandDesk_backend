const mysql = require('mysql2/promise');

let orderDb = null;

function getOrderDb() {
  if (orderDb) return orderDb;

  if (!process.env.ORDER_DB_HOST) {
    throw new Error('ORDER_DB_HOST not configured in .env');
  }

  orderDb = mysql.createPool({
    host:     process.env.ORDER_DB_HOST,
    port:     parseInt(process.env.ORDER_DB_PORT || '3306'),
    database: process.env.ORDER_DB_NAME,
    user:     process.env.ORDER_DB_USER,
    password: process.env.ORDER_DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 5,
    timezone: '+00:00',
    dateStrings: false,
  });

  return orderDb;
}

module.exports = { getOrderDb };