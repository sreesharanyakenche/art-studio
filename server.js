const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

// ---- minimal .env loader (no extra dependency) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'seed.json'), 'utf8'));

// ---- database ----
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'studio.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','admin')));
CREATE TABLE IF NOT EXISTS paintings (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist TEXT, description TEXT, image_url TEXT,
  price REAL NOT NULL CHECK (price > 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','sold')));
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  painting_id INTEGER NOT NULL REFERENCES paintings(id), price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','cancelled')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- backstop: at most one active order per painting
CREATE UNIQUE INDEX IF NOT EXISTS one_active_order ON orders(painting_id) WHERE status = 'placed';
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL, wall_sqft INTEGER NOT NULL, address TEXT NOT NULL, price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','declined','cancelled')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- each date can be held by only one live booking; declined/cancelled free the date
CREATE UNIQUE INDEX IF NOT EXISTS one_live_booking_per_date ON bookings(date) WHERE status IN ('requested','confirmed');
CREATE TABLE IF NOT EXISTS pottery (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  item TEXT NOT NULL, glaze TEXT NOT NULL, quantity INTEGER NOT NULL, needed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','declined','cancelled')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// seed once
if (!db.prepare('SELECT 1 FROM paintings').get()) {
  const ins = db.prepare('INSERT INTO paintings (title, artist, description, image_url, price, status) VALUES (?,?,?,?,?,?)');
  for (const p of seed.paintings) ins.run(p.title, p.artist || '', p.description || '', p.imageUrl || null, p.price, p.status === 'sold' ? 'sold' : 'available');
}
// studio account comes from the seed data (there is no studio sign-up)
const adminEmail = seed.studioAccount.email.toLowerCase();
if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(adminEmail)) {
  db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?,?,?)')
    .run(adminEmail, bcrypt.hashSync(seed.studioAccount.password, 10), 'admin');
}

// ---- helpers ----
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };

// BEGIN IMMEDIATE takes the write lock up-front, so check-then-write is atomic.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const DAY = 86400000;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
function daysUntil(s) {
  const n = new Date(), today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((Date.parse(s + 'T00:00:00Z') - today) / DAY);
}
const isInt = (v) => Number.isInteger(v);

// ---- auth middleware ----
function auth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return next(new HttpError(401, 'Please log in'));
  try {
    const { id } = jwt.verify(m[1], JWT_SECRET);
    const user = db.prepare('SELECT id, email, role FROM users WHERE id=?').get(id);
    if (!user) throw new Error('no user');
    req.user = user; next();
  } catch { next(new HttpError(401, 'Session invalid or expired, please log in again')); }
}
const role = (r) => (req, res, next) =>
  req.user.role === r ? next() : next(new HttpError(403, `This action is for the ${r} role only`));

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- auth routes (customer sign-up only; studio account comes from seed) ----
const tokenFor = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '8h' });
app.post('/api/signup', wrap((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Enter a valid email');
  if (password.length < 6) throw bad('Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'Email already registered');
  const r = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?,?,?)')
    .run(email, bcrypt.hashSync(password, 10), 'customer');
  const user = { id: Number(r.lastInsertRowid), email, role: 'customer' };
  res.status(201).json({ token: tokenFor(user), user });
}));
app.post('/api/login', wrap((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash))
    throw new HttpError(401, 'Wrong email or password');
  res.json({ token: tokenFor(u), user: { id: u.id, email: u.email, role: u.role } });
}));

// everything below needs a logged-in user
app.use('/api', auth);

app.get('/api/me', (req, res) => res.json(req.user));
app.get('/api/config', (req, res) => res.json({
  currency: seed.currency, wallRate: seed.mural.ratePerSqFt,
  potteryItems: seed.potteryItems.map(i => i.name), glazes: seed.glazes.map(g => g.name) }));

// ---- paintings ----
// Optional image arrives as a data URL; validate type and size, save to public/uploads, return its URL path.
const UPLOADS = path.join(__dirname, 'public', 'uploads');
function saveImage(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw bad('Image must be a PNG, JPEG or WebP file');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw bad('Image must be under 2 MB');
  fs.mkdirSync(UPLOADS, { recursive: true });
  const name = require('crypto').randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return 'uploads/' + name;
}
function paintingBody(b) {
  const title = String(b.title || '').trim(), price = Number(b.price);
  if (!title) throw bad('Title is required');
  if (!(price > 0)) throw bad('Price must be greater than 0');
  return [title, String(b.artist || '').trim(), String(b.description || '').trim(), price];
}
app.get('/api/paintings', wrap((req, res) =>
  res.json(db.prepare('SELECT * FROM paintings ORDER BY id DESC').all())));
app.post('/api/paintings', role('admin'), wrap((req, res) => {
  const vals = paintingBody(req.body), img = saveImage(req.body.image_data);
  const r = db.prepare('INSERT INTO paintings (title, artist, description, price, image_url) VALUES (?,?,?,?,?)').run(...vals, img);
  res.status(201).json(db.prepare('SELECT * FROM paintings WHERE id=?').get(r.lastInsertRowid));
}));
app.put('/api/paintings/:id', role('admin'), wrap((req, res) => {
  const vals = paintingBody(req.body), img = saveImage(req.body.image_data);
  // single conditional UPDATE: only succeeds while still available
  const r = db.prepare("UPDATE paintings SET title=?, artist=?, description=?, price=?, image_url=COALESCE(?, image_url) WHERE id=? AND status='available'")
    .run(...vals, img, req.params.id);
  if (!r.changes) {
    if (!db.prepare('SELECT 1 FROM paintings WHERE id=?').get(req.params.id)) throw new HttpError(404, 'Painting not found');
    throw new HttpError(409, 'This painting is sold and can no longer be edited');
  }
  res.json(db.prepare('SELECT * FROM paintings WHERE id=?').get(req.params.id));
}));

// delete only while up for sale and never ordered (orders keep a reference to their painting)
app.delete('/api/paintings/:id', role('admin'), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM paintings WHERE id=?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Painting not found');
  const r = db.prepare(`DELETE FROM paintings WHERE id=? AND status='available'
    AND NOT EXISTS (SELECT 1 FROM orders WHERE painting_id=paintings.id)`).run(p.id);
  if (!r.changes) {
    throw new HttpError(409, p.status === 'sold' ? 'A sold painting cannot be deleted'
      : 'This painting has order history and cannot be deleted');
  }
  if (p.image_url && p.image_url.startsWith('uploads/')) fs.rm(path.join(__dirname, 'public', p.image_url), () => {});
  res.json({ ok: true });
}));

// ---- orders ----
const ORDER_SQL = `SELECT x.*, p.title AS painting_title, u.email AS customer_email
  FROM orders x JOIN paintings p ON p.id=x.painting_id JOIN users u ON u.id=x.user_id`;
app.post('/api/orders', role('customer'), wrap((req, res) => {
  const pid = Number(req.body.painting_id);
  const order = tx(() => {
    const p = db.prepare('SELECT * FROM paintings WHERE id=?').get(pid);
    if (!p) throw new HttpError(404, 'Painting not found');
    // atomic claim: only one caller can flip available -> sold
    const claim = db.prepare("UPDATE paintings SET status='sold' WHERE id=? AND status='available'").run(pid);
    if (!claim.changes) throw new HttpError(409, 'Sorry, this painting was just sold');
    const r = db.prepare('INSERT INTO orders (user_id, painting_id, price) VALUES (?,?,?)').run(req.user.id, pid, p.price);
    return db.prepare(ORDER_SQL + ' WHERE x.id=?').get(r.lastInsertRowid);
  });
  res.status(201).json(order);
}));
app.get('/api/orders', wrap((req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(ORDER_SQL + ' ORDER BY x.id DESC').all()
    : db.prepare(ORDER_SQL + ' WHERE x.user_id=? ORDER BY x.id DESC').all(req.user.id);
  res.json(rows);
}));
app.post('/api/orders/:id/cancel', role('customer'), wrap((req, res) => {
  const out = tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (o.status !== 'placed') throw new HttpError(409, 'Order is already cancelled');
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(o.id);
    db.prepare("UPDATE paintings SET status='available' WHERE id=?").run(o.painting_id);
    return db.prepare(ORDER_SQL + ' WHERE x.id=?').get(o.id);
  });
  res.json(out);
}));

// ---- wall bookings ----
const BOOKING_SQL = 'SELECT x.*, u.email AS customer_email FROM bookings x JOIN users u ON u.id=x.user_id';
app.post('/api/bookings', role('customer'), wrap((req, res) => {
  const { date, wall_sqft, address } = req.body;
  if (!isDate(date)) throw bad('Pick a valid date');
  const d = daysUntil(date);
  if (d < 7 || d > 90) throw bad('Date must be between 7 and 90 days from today');
  if (!isInt(wall_sqft) || wall_sqft < 10 || wall_sqft > 500) throw bad('Wall size must be a whole number from 10 to 500 sq ft');
  if (!String(address || '').trim()) throw bad('Address is required');
  const price = wall_sqft * seed.mural.ratePerSqFt;
  try {
    // the partial unique index on date makes this atomic: a concurrent second insert fails
    const r = db.prepare('INSERT INTO bookings (user_id, date, wall_sqft, address, price) VALUES (?,?,?,?,?)')
      .run(req.user.id, date, wall_sqft, String(address).trim(), price);
    res.status(201).json(db.prepare(BOOKING_SQL + ' WHERE x.id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Sorry, that date was just taken. Please pick another');
    throw e;
  }
}));
app.get('/api/bookings', wrap((req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(BOOKING_SQL + ' ORDER BY x.date').all()
    : db.prepare(BOOKING_SQL + ' WHERE x.user_id=? ORDER BY x.date').all(req.user.id);
  res.json(rows);
}));
// dates already held (no personal data) so the UI can warn
app.get('/api/bookings/taken-dates', wrap((req, res) =>
  res.json(db.prepare("SELECT date FROM bookings WHERE status IN ('requested','confirmed') ORDER BY date").all().map(r => r.date))));
app.post('/api/bookings/:id/cancel', role('customer'), wrap((req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (!['requested', 'confirmed'].includes(b.status)) throw new HttpError(409, `Booking is already ${b.status}`);
  if (daysUntil(b.date) < 3) throw new HttpError(409, 'Bookings can only be cancelled until 3 days before the date');
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id);
  res.json(db.prepare(BOOKING_SQL + ' WHERE x.id=?').get(b.id));
}));

// admin decision: only moves a row out of 'requested'
function decide(table, allowed, selectSql) {
  return wrap((req, res) => {
    const next = allowed[req.params.action];
    const r = db.prepare(`UPDATE ${table} SET status=? WHERE id=? AND status='requested'`).run(next, req.params.id);
    if (!r.changes) {
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(req.params.id)) throw new HttpError(404, 'Not found');
      throw new HttpError(409, 'Only requests still in "requested" can be decided');
    }
    res.json(db.prepare(selectSql + ' WHERE x.id=?').get(req.params.id));
  });
}
app.post('/api/bookings/:id/:action(confirm|decline)', role('admin'),
  decide('bookings', { confirm: 'confirmed', decline: 'declined' }, BOOKING_SQL));

// ---- pottery ----
const POT_SQL = 'SELECT x.*, u.email AS customer_email FROM pottery x JOIN users u ON u.id=x.user_id';
function potteryBody(b) {
  const item = seed.potteryItems.find(i => i.name === b.item);
  if (!item) throw bad('Choose an item from the list');
  if (!seed.glazes.some(g => g.name === b.glaze)) throw bad('Choose a glaze from the list');
  if (!isInt(b.quantity) || b.quantity < 1 || b.quantity > 12) throw bad('Quantity must be a whole number from 1 to 12');
  if (!isDate(b.needed_by) || daysUntil(b.needed_by) < 14) throw bad('Needed-by date must be at least 14 days from today');
  return [item.name, b.glaze, b.quantity, b.needed_by];
}
app.post('/api/pottery', role('customer'), wrap((req, res) => {
  const r = db.prepare('INSERT INTO pottery (user_id, item, glaze, quantity, needed_by) VALUES (?,?,?,?,?)')
    .run(req.user.id, ...potteryBody(req.body));
  res.status(201).json(db.prepare(POT_SQL + ' WHERE x.id=?').get(r.lastInsertRowid));
}));
app.get('/api/pottery', wrap((req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(POT_SQL + ' ORDER BY x.id DESC').all()
    : db.prepare(POT_SQL + ' WHERE x.user_id=? ORDER BY x.id DESC').all(req.user.id);
  res.json(rows);
}));
app.put('/api/pottery/:id', role('customer'), wrap((req, res) => {
  const own = db.prepare('SELECT * FROM pottery WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!own) throw new HttpError(404, 'Request not found');
  const vals = potteryBody(req.body);
  const r = db.prepare("UPDATE pottery SET item=?, glaze=?, quantity=?, needed_by=? WHERE id=? AND status='requested'")
    .run(...vals, own.id);
  if (!r.changes) throw new HttpError(409, 'Only requests still in "requested" can be edited');
  res.json(db.prepare(POT_SQL + ' WHERE x.id=?').get(own.id));
}));
app.post('/api/pottery/:id/cancel', role('customer'), wrap((req, res) => {
  const own = db.prepare('SELECT * FROM pottery WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!own) throw new HttpError(404, 'Request not found');
  const r = db.prepare("UPDATE pottery SET status='cancelled' WHERE id=? AND status='requested'").run(own.id);
  if (!r.changes) throw new HttpError(409, 'Only requests still in "requested" can be cancelled');
  res.json(db.prepare(POT_SQL + ' WHERE x.id=?').get(own.id));
}));
app.post('/api/pottery/:id/:action(accept|decline)', role('admin'),
  decide('pottery', { accept: 'accepted', decline: 'declined' }, POT_SQL));

// ---- errors ----
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server' });
});

if (require.main === module) app.listen(PORT, () => console.log(`Art studio running on http://localhost:${PORT}`));
module.exports = app;
