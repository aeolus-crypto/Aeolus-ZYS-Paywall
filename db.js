'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'db', 'paywall.db');

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id              TEXT PRIMARY KEY,
    subaddress      TEXT NOT NULL,
    subaddr_index   INTEGER NOT NULL,
    expected_amount INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    download_token  TEXT,
    token_used      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const createOrder      = db.prepare(`INSERT INTO orders (id, subaddress, subaddr_index, expected_amount) VALUES (@id, @subaddress, @subaddr_index, @expected_amount)`);
const getOrder         = db.prepare(`SELECT * FROM orders WHERE id = ?`);
const getPendingOrders = db.prepare(`SELECT * FROM orders WHERE status = 'pending'`);
const confirmOrder     = db.prepare(`UPDATE orders SET status = 'confirmed', download_token = @token WHERE id = @id`);
const markTokenUsed    = db.prepare(`UPDATE orders SET token_used = 1 WHERE id = ?`);
const getOrderByToken  = db.prepare(`SELECT * FROM orders WHERE download_token = ?`);

module.exports = {
  createOrder:      (o) => createOrder.run(o),
  getOrder:         (id) => getOrder.get(id),
  getPendingOrders: () => getPendingOrders.all(),
  confirmOrder:     (id, token) => confirmOrder.run({ id, token }),
  markTokenUsed:    (id) => markTokenUsed.run(id),
  getOrderByToken:  (token) => getOrderByToken.get(token),
};
