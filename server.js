'use strict';
// Minimal .env loader for local development; deployment platforms can provide env vars directly.
const envFile = path => {
  try {
    const lines = require('fs').readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
};
const path = require('path');
envFile(path.join(__dirname, '.env'));
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA = path.resolve(process.env.DATA_DIR || ROOT);
const UP = process.env.DATA_DIR ? path.join(DATA, 'uploads') : path.join(DATA, 'public', 'uploads');
const FILE = path.join(DATA, 'menu.json');
const CFG = path.join(DATA, 'config.json');
const SC = path.join(DATA, 'scans.json');
const app = express();
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const tokens = new Map();
const loginAttempts = new Map();

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UP, { recursive: true });

// On the first deploy to an empty persistent disk, copy the project's starter data.
function copyIfMissing(source, destination) {
  if (fs.existsSync(destination) || !fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
copyIfMissing(path.join(ROOT, 'menu.json'), FILE);
copyIfMissing(path.join(ROOT, 'config.json'), CFG);
// Repair an older local data/config.json that has an empty restaurant name.
try {
  const currentConfig = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const defaultConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (typeof currentConfig.name !== 'string' || !currentConfig.name.trim()) {
    currentConfig.name = defaultConfig.name || 'Jalandhar Dhabe Wale';
    fs.writeFileSync(CFG, JSON.stringify(currentConfig, null, 2) + '\n');
  }
} catch (err) {
  console.error('Could not repair restaurant name in config:', err.message);
}
copyIfMissing(path.join(ROOT, 'scans.json'), SC);
const sourceUploads = path.join(ROOT, 'public', 'uploads');
if (fs.existsSync(sourceUploads)) {
  for (const name of fs.readdirSync(sourceUploads)) {
    if (/^[a-f0-9]+\.jpg$/i.test(name)) copyIfMissing(path.join(sourceUploads, name), path.join(UP, name));
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') return fallback;
    console.error(`Could not read ${path.basename(file)}:`, err.message);
    return fallback;
  }
}
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
const TAGS = ['gluten', 'nuts', 'dairy', 'spicy', 'vegan'];
const OK_IMG = /^\/uploads\/[a-f0-9]+\.jpg$/i;
const envOrConfig = (key, envName, fallback = '') => {
  const value = process.env[envName];
  return value !== undefined ? value : (readJson(CFG, {})[key] ?? fallback);
};
function publicConfig() {
  const cfg = readJson(CFG, {});
  return {
    name: (String(envOrConfig('name', 'RESTAURANT_NAME', '') || '').trim() || String(cfg.name || '').trim() || 'Jalandhar Dhabe Wale'),
    tagline: envOrConfig('tagline', 'RESTAURANT_TAGLINE', ''),
    currency: envOrConfig('currency', 'CURRENCY', '₹'),
    lang2: envOrConfig('lang2', 'LANG2', ''),
    instagram: envOrConfig('instagram', 'INSTAGRAM', ''),
    googleReview: envOrConfig('googleReview', 'GOOGLE_REVIEW', ''),
    phone: envOrConfig('phone', 'RESTAURANT_PHONE', ''),
    location: envOrConfig('location', 'RESTAURANT_LOCATION', ''),
    ticker: Array.isArray(process.env.TICKER_TEXT ? process.env.TICKER_TEXT.split('|') : cfg.ticker) ? (process.env.TICKER_TEXT ? process.env.TICKER_TEXT.split('|') : cfg.ticker) : [],
    whatsapp: envOrConfig('whatsapp', 'WHATSAPP_NUMBER', ''),
    week1Start: envOrConfig('week1Start', 'WEEK1_START', '')
  };
}
app.disable('x-powered-by');
// Render terminates TLS at its proxy; trust the nearest proxy for client IP-based throttling.
if (process.env.RENDER) app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use('/uploads', express.static(UP, { dotfiles: 'deny', index: false, maxAge: '7d' }));
// The owner opens the separate password-protected admin panel at /admin.
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.use(express.static(path.join(ROOT, 'public')));

function auth(req, res, next) {
  const token = req.headers['x-token'];
  const expiry = tokens.get(token);
  if (!token || !expiry || expiry < Date.now()) {
    if (token) tokens.delete(token);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  next();
}
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json(publicConfig()));
app.get('/api/menu', (req, res) => res.json(readJson(FILE, [])));

app.post('/api/hit', (req, res) => {
  const table = String((req.body || {}).table || '').replace(/[^\w-]/g, '').slice(0, 10);
  const stats = readJson(SC, { total: 0, tables: {} });
  stats.total = (Number(stats.total) || 0) + 1;
  if (table) stats.tables[table] = (Number(stats.tables[table]) || 0) + 1;
  writeJson(SC, stats);
  res.json({ ok: true });
});
app.get('/api/stats', auth, (req, res) => res.json(readJson(SC, { total: 0, tables: {} })));

app.post('/api/login', (req, res) => {
  for (const [token, expiry] of tokens) if (expiry <= Date.now()) tokens.delete(token);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = loginAttempts.get(ip) || { failures: 0, lockUntil: 0 };
  if (Date.now() < attempt.lockUntil) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const configuredPassword = process.env.ADMIN_PASSWORD || '';
  const suppliedPassword = (req.body || {}).password;
  const passwordMatches = typeof suppliedPassword === 'string' && configuredPassword.length > 0 && Buffer.byteLength(suppliedPassword) === Buffer.byteLength(configuredPassword) && crypto.timingSafeEqual(Buffer.from(suppliedPassword), Buffer.from(configuredPassword));
  if (!passwordMatches) {
    attempt.failures += 1;
    if (attempt.failures >= 5) { attempt.lockUntil = Date.now() + 60_000; attempt.failures = 0; }
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Wrong password' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  res.json({ token });
});
app.get('/api/check', auth, (req, res) => res.json({ ok: true }));
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-token'];
  if (token) tokens.delete(token);
  res.status(200).json({ ok: true });
});

app.post('/api/upload', auth, express.raw({ type: 'image/*', limit: '3mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 4) return res.status(400).json({ error: 'No photo received' });
  // The current client resizes uploads to JPEG; reject arbitrary file payloads.
  if (req.body[0] !== 0xff || req.body[1] !== 0xd8 || req.body[2] !== 0xff) {
    return res.status(415).json({ error: 'Please upload a valid JPEG image' });
  }
  const filename = crypto.randomBytes(12).toString('hex') + '.jpg';
  fs.writeFileSync(path.join(UP, filename), req.body, { flag: 'wx', mode: 0o644 });
  res.json({ url: '/uploads/' + filename });
});

const str = (value, max) => String(value == null ? '' : value).slice(0, max);
function clean(body, item) {
  const b = body || {};
  const out = { ...item };
  if ('name' in b) out.name = str(b.name, 80);
  if ('desc' in b) out.desc = str(b.desc, 200);
  if ('name2' in b) out.name2 = str(b.name2, 80);
  if ('desc2' in b) out.desc2 = str(b.desc2, 200);
  if ('category' in b) out.category = str(b.category, 40);
  if ('veg' in b) out.veg = !!b.veg;
  if ('special' in b) out.special = !!b.special;
  if ('tags' in b) out.tags = (Array.isArray(b.tags) ? b.tags : []).filter(tag => TAGS.includes(tag));
  if ('img' in b) out.img = OK_IMG.test(b.img || '') ? b.img : '';
  if ('price' in b) {
    if (b.price === '' || b.price == null) { out.price = null; out.priceLabel = out.priceLabel || 'Included'; }
    else {
      const price = Number(b.price);
      if (!Number.isFinite(price) || price < 0 || price > 1_000_000) out.price = NaN;
      else out.price = price;
      delete out.priceLabel;
    }
  }
  return out;
}
const valid = item => typeof item.name === 'string' && item.name.trim() && typeof item.category === 'string' && item.category.trim() && (item.price === null || (Number.isFinite(item.price) && item.price >= 0));
function deleteUnusedImage(imageUrl, menu) {
  if (!imageUrl || menu.some(item => item.img === imageUrl) || !OK_IMG.test(imageUrl)) return;
  fs.unlink(path.join(UP, path.basename(imageUrl)), err => { if (err && err.code !== 'ENOENT') console.error('Could not remove unused image:', err.message); });
}
app.post('/api/items', auth, (req, res) => {
  const item = clean(req.body, { id: crypto.randomBytes(8).toString('hex'), desc: '', name2: '', desc2: '', price: null, veg: true, special: false, tags: [], img: '', available: true });
  if (!valid(item)) return res.status(400).json({ error: 'Name, category and a valid price are required' });
  const menu = readJson(FILE, []);
  menu.push(item);
  writeJson(FILE, menu);
  res.json({ ok: true });
});
app.put('/api/items/:id', auth, (req, res) => {
  const menu = readJson(FILE, []);
  const index = menu.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Item not found' });
  const oldItem = menu[index];
  const item = clean(req.body, oldItem);
  if (!valid(item)) return res.status(400).json({ error: 'Name, category and a valid price are required' });
  menu[index] = item;
  writeJson(FILE, menu);
  if (oldItem.img !== item.img) deleteUnusedImage(oldItem.img, menu);
  res.json({ ok: true });
});
app.patch('/api/items/:id', auth, (req, res) => {
  const menu = readJson(FILE, []);
  const item = menu.find(entry => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.available = !item.available;
  writeJson(FILE, menu);
  res.json({ ok: true });
});
app.delete('/api/items/:id', auth, (req, res) => {
  const menu = readJson(FILE, []);
  const item = menu.find(entry => entry.id === req.params.id);
  const remaining = menu.filter(entry => entry.id !== req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  writeJson(FILE, remaining);
  deleteUnusedImage(item.img, remaining);
  res.json({ ok: true });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`QR menu server listening on port ${port}; data directory: ${DATA}`));
