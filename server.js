'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) require('dotenv').config({ path: ENV_PATH });

const PORT          = parseInt(process.env.PORT || '3002', 10);
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const VIEWS         = path.join(__dirname, 'views');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Template renderer ──────────────────────────────────────────────────────────
function render(res, tpl, vars = {}) {
  fs.readFile(path.join(VIEWS, tpl + '.html'), 'utf8', (err, content) => {
    if (err) return res.status(500).send('Template error: ' + tpl);
    const html = content.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      vars[k] !== undefined ? String(vars[k]) : ''
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

app.use((req, res, next) => { res.render = (t, v) => render(res, t, v); next(); });

// ── ZYS rate cache (from wallet RPC reserve info) ──────────────────────────────
// zysToZsd = zsd_in_yield_reserve / total_zys_supply
// Since ZSD ≈ $1, zysToZsd ≈ USD value of 1 ZYS
let zysRateCache   = null;
let lastRateFetch  = 0;

async function getZysRate() {
  const now = Date.now();
  if (zysRateCache && now - lastRateFetch < 60_000) return zysRateCache;
  try {
    const { getZysRate: fetchRate } = require('./wallet');
    const rate = await fetchRate();
    if (rate) {
      zysRateCache  = rate;
      lastRateFetch = now;
      console.log(`[rate] 1 ZYS = $${rate.toFixed(6)} USD (via reserve)`);
    }
  } catch (e) {
    console.error('[rate] fetch failed:', e.message);
  }
  return zysRateCache;
}

// Pre-fetch on startup
getZysRate();

// ── Setup check ────────────────────────────────────────────────────────────────
function isConfigured() {
  return !!(
    process.env.PRODUCT_NAME &&
    process.env.PRODUCT_FILE &&
    process.env.PRODUCT_PRICE_USD &&
    process.env.JWT_SECRET
  );
}

// ── Setup wizard ───────────────────────────────────────────────────────────────
app.get('/setup', (req, res) => {
  res.render('setup', { errorBlock: '' });
});

app.post('/setup', async (req, res) => {
  const { product_name, product_desc, product_file, product_price, wallet_rpc } = req.body;

  if (!product_name || !product_file || !product_price) {
    const errorBlock = `<div class="error">Product name, file, and price are required.</div>`;
    return res.render('setup', { errorBlock });
  }

  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const rpcUrl    = wallet_rpc || 'http://127.0.0.1:17777/json_rpc';

  const envContent = [
    `PRODUCT_NAME=${product_name}`,
    `PRODUCT_DESC=${product_desc || ''}`,
    `PRODUCT_FILE=${product_file}`,
    `PRODUCT_PRICE_USD=${product_price}`,
    `WALLET_RPC_URL=${rpcUrl}`,
    `JWT_SECRET=${jwtSecret}`,
    `REQUIRED_CONFIRMATIONS=3`,
    `POLL_INTERVAL_MS=30000`,
    `PORT=${PORT}`,
  ].join('\n');

  fs.writeFileSync(ENV_PATH, envContent);
  require('dotenv').config({ path: ENV_PATH, override: true });

  const poller = require('./poller');
  poller.start();

  res.redirect('/');
});

// ── API: test wallet ───────────────────────────────────────────────────────────
app.get('/api/test-wallet', async (req, res) => {
  try {
    const { rpcUrl } = req.query;
    if (rpcUrl) process.env.WALLET_RPC_URL = rpcUrl;
    const { testConnection } = require('./wallet');
    const ok = await testConnection();
    res.json({ ok });
  } catch { res.json({ ok: false }); }
});

// ── API: live ZYS rate ─────────────────────────────────────────────────────────
app.get('/api/zys-rate', async (req, res) => {
  const rate = await getZysRate();
  res.json({ zysToUsd: rate });
});

// ── Config guard ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!isConfigured() && !req.path.startsWith('/setup') && !req.path.startsWith('/api')) {
    return res.redirect('/setup');
  }
  next();
});

function getDb() { return require('./db'); }

// ── Store page ─────────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');

  const priceUsd = parseFloat(process.env.PRODUCT_PRICE_USD || '0');
  const rate     = await getZysRate();
  const zysAmt   = rate ? (priceUsd / rate).toFixed(4) : '—';

  res.render('index', {
    productName: esc(process.env.PRODUCT_NAME || ''),
    productDesc: esc(process.env.PRODUCT_DESC || ''),
    priceUsd:    priceUsd.toFixed(2),
    priceZys:    zysAmt,
    rateAvail:   rate ? '1' : '',
  });
});

// ── Initiate payment ───────────────────────────────────────────────────────────
app.post('/pay', async (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');

  const rate = await getZysRate();
  if (!rate) return res.render('error', { message: 'Could not fetch ZYS rate from wallet. Make sure wallet RPC is running.' });

  const { createAddress } = require('./wallet');
  const { createOrder }   = getDb();

  const priceUsd    = parseFloat(process.env.PRODUCT_PRICE_USD);
  const zysAmt      = priceUsd / rate;
  const amountAtomic = Math.round(zysAmt * 1e12);

  let address, address_index;
  try {
    ({ address, address_index } = await createAddress(`order-${uuidv4()}`));
  } catch (err) {
    console.error('[server] createAddress failed:', err.message);
    return res.render('error', { message: 'Wallet unavailable — make sure wallet RPC is running.' });
  }

  const orderId = uuidv4();
  createOrder({ id: orderId, subaddress: address, subaddr_index: address_index, expected_amount: amountAtomic });
  res.redirect(`/order/${orderId}`);
});

// ── Payment status page ────────────────────────────────────────────────────────
app.get('/order/:orderId', async (req, res) => {
  const { getOrder } = getDb();
  const order = getOrder(req.params.orderId);
  if (!order) return res.render('error', { message: 'Order not found.' });

  const zysAmt  = (order.expected_amount / 1e12).toFixed(4);
  const rate    = await getZysRate();
  const usdAmt  = rate ? (parseFloat(zysAmt) * rate).toFixed(2) : '—';

  res.render('payment', {
    orderId:     order.id,
    productName: esc(process.env.PRODUCT_NAME || ''),
    subaddress:  order.subaddress,
    zysAmount:   zysAmt,
    usdAmount:   usdAmt,
  });
});

// ── JSON status poll ───────────────────────────────────────────────────────────
app.get('/api/order/:orderId/status', (req, res) => {
  const { getOrder } = getDb();
  const order = getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({
    status:         order.status,
    download_token: order.status === 'confirmed' ? order.download_token : null,
  });
});

// ── Download ───────────────────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  const { token } = req.query;
  if (!token) return res.render('error', { message: 'Missing download token.' });

  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.render('error', { message: 'Download link is invalid or expired.' }); }

  const { getOrderByToken, markTokenUsed } = getDb();
  const order = getOrderByToken(token);
  if (!order)           return res.render('error', { message: 'Order not found.' });
  if (order.token_used) return res.render('error', { message: 'This download link has already been used.' });
  if (order.status !== 'confirmed') return res.render('error', { message: 'Payment not confirmed.' });

  const filename = process.env.PRODUCT_FILE;
  const filePath = path.resolve(DOWNLOADS_DIR, path.basename(filename));
  if (!filePath.startsWith(DOWNLOADS_DIR))
    return res.render('error', { message: 'Invalid file path.' });
  if (!fs.existsSync(filePath))
    return res.render('error', { message: 'File not found on server — contact support.' });

  markTokenUsed(order.id);
  res.download(filePath, filename, err => {
    if (err) console.error('[server] download error:', err.message);
  });
});

// ── Admin ──────────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');
  const db = require('better-sqlite3')(
    process.env.DB_PATH
      ? path.resolve(process.env.DB_PATH)
      : path.join(__dirname, 'db', 'paywall.db')
  );
  const orders = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all();
  db.close();

  const rows = orders.map(o => {
    const amt  = (o.expected_amount / 1e12).toFixed(4);
    const date = o.created_at.replace('T', ' ').slice(0, 19);
    const statusColor = o.status === 'confirmed' ? '#2da44e' : '#d4a72c';
    const used = o.token_used ? ' (used)' : '';
    return `<tr>
      <td class="mono">${esc(o.id)}</td>
      <td>${date}</td>
      <td>${amt} ZYS</td>
      <td style="color:${statusColor};font-weight:600">${esc(o.status)}${used}</td>
      <td class="mono small">${esc(o.subaddress)}</td>
    </tr>`;
  }).join('');

  const total     = orders.length;
  const confirmed = orders.filter(o => o.status === 'confirmed').length;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><title>ZYS Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;background:#0d1117;color:#e6edf3;padding:24px 16px}
  h1{font-size:1.3em;margin-bottom:6px}
  .sub{color:#8b949e;margin-bottom:20px;font-size:13px}
  .stats{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;min-width:120px}
  .stat-n{font-size:1.8em;font-weight:700}
  .stat-l{font-size:12px;color:#8b949e;margin-top:2px}
  .search{margin-bottom:16px}
  input{background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:7px 12px;font-size:13px;width:100%;max-width:420px;outline:none}
  input:focus{border-color:#58a6ff}
  .wrap{overflow-x:auto;border:1px solid #30363d;border-radius:8px}
  table{width:100%;border-collapse:collapse;min-width:700px}
  th{background:#161b22;color:#8b949e;font-size:12px;font-weight:600;text-align:left;padding:10px 14px;border-bottom:1px solid #30363d;text-transform:uppercase;letter-spacing:.05em}
  td{padding:10px 14px;border-bottom:1px solid #21262d;vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#161b22}
  .mono{font-family:'SFMono-Regular',Consolas,monospace;font-size:12px}
  .small{font-size:11px;word-break:break-all;max-width:260px}
  .empty{text-align:center;padding:40px;color:#8b949e}
</style></head><body>
<h1>🌾 ZYS Paywall — Orders</h1>
<p class="sub">All orders, newest first</p>
<div class="stats">
  <div class="stat"><div class="stat-n">${total}</div><div class="stat-l">Total Orders</div></div>
  <div class="stat"><div class="stat-n" style="color:#2da44e">${confirmed}</div><div class="stat-l">Confirmed</div></div>
  <div class="stat"><div class="stat-n" style="color:#d4a72c">${total - confirmed}</div><div class="stat-l">Pending</div></div>
</div>
<div class="search">
  <input id="q" placeholder="Search by order ID, address, or status…" oninput="filter()">
</div>
<div class="wrap">
<table id="tbl">
<thead><tr><th>Order ID</th><th>Date</th><th>Amount</th><th>Status</th><th>Subaddress</th></tr></thead>
<tbody id="body">${rows || '<tr><td colspan="5" class="empty">No orders yet</td></tr>'}</tbody>
</table></div>
<script>
const rows = document.querySelectorAll('#body tr');
function filter(){
  const q = document.getElementById('q').value.toLowerCase();
  rows.forEach(r => r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none');
}
</script>
</body></html>`);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ZYS Paywall → http://localhost:${PORT}\n`);
  if (!isConfigured()) {
    console.log('  ⚠  Not configured yet.');
    console.log(`  → Open http://localhost:${PORT}/setup to get started\n`);
  } else {
    const poller = require('./poller');
    poller.start();
  }
});

process.on('SIGTERM', () => { try { require('./poller').stop(); } catch {} process.exit(0); });
process.on('SIGINT',  () => { try { require('./poller').stop(); } catch {} process.exit(0); });
