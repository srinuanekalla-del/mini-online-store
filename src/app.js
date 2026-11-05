const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

// ---------- validation helpers (all input is validated on the server) ----------
const str = (v, name, min, max) => {
  if (typeof v !== 'string') throw bad(`${name} is required.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${name} must be ${min}-${max} characters.`);
  return s;
};
const int = (v, name, min, max) => {
  const n = Number(v);
  if (v === '' || v === null || !Number.isInteger(n) || n < min || n > max)
    throw bad(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
};
const money = (v, name) => { // rupees (may have decimals) -> paise
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n <= 0 || n > 10_000_000)
    throw bad(`${name} must be a positive amount.`);
  return Math.round(n * 100);
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NEXT_STATUS = { Placed: 'Shipped', Shipped: 'Delivered' };

function createApp(db, { jwtSecret = process.env.JWT_SECRET, lowStock = Number(process.env.LOW_STOCK_THRESHOLD) || 5 } = {}) {
  if (!jwtSecret) throw new Error('JWT_SECRET is not set. Copy .env.example to .env first.');
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const wrap = (fn) => (req, res, next) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); }
  };

  // ---------- auth ----------
  const sign = (u) => jwt.sign({ id: u.id }, jwtSecret, { expiresIn: '7d' });
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

  const auth = (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return next(new HttpError(401, 'Please log in to continue.'));
    try {
      const { id } = jwt.verify(token, jwtSecret);
      const user = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(id);
      if (!user) throw new Error('no user');
      req.user = user;
      next();
    } catch {
      next(new HttpError(401, 'Your session has expired. Please log in again.'));
    }
  };
  const adminOnly = [auth, (req, res, next) =>
    req.user.role === 'admin' ? next() : next(new HttpError(403, 'Admin access required.'))];

  app.post('/api/auth/register', wrap((req) => {
    const name = str(req.body.name, 'Name', 2, 60);
    const email = str(req.body.email, 'Email', 5, 120).toLowerCase();
    if (!EMAIL.test(email)) throw bad('Enter a valid email address.');
    const password = str(req.body.password, 'Password', 8, 100);
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email))
      throw new HttpError(409, 'An account with this email already exists.');
    const info = db.prepare('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)')
      .run(name, email, bcrypt.hashSync(password, 10));
    const user = { id: info.lastInsertRowid, name, email, role: 'customer' };
    return { token: sign(user), user };
  }));

  app.post('/api/auth/login', wrap((req) => {
    const email = str(req.body.email, 'Email', 1, 120).toLowerCase();
    const password = str(req.body.password, 'Password', 1, 100);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !bcrypt.compareSync(password, u.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
    return { token: sign(u), user: publicUser(u) };
  }));

  app.get('/api/me', auth, wrap((req) => ({ user: req.user })));

  // ---------- catalogue ----------
  app.get('/api/categories', wrap(() =>
    db.prepare('SELECT DISTINCT category FROM products WHERE active=1 ORDER BY category').all().map((r) => r.category)));

  app.get('/api/products', wrap((req) => {
    const { category, minPrice, maxPrice, sort, q } = req.query;
    const where = ['active=1'];
    const args = [];
    if (category) { where.push('category=?'); args.push(String(category)); }
    let min = null, max = null;
    if (minPrice !== undefined && minPrice !== '') {
      const n = Number(minPrice);
      if (!(n >= 0)) throw bad('Minimum price must be 0 or more.');
      min = Math.round(n * 100); where.push('price_cents>=?'); args.push(min);
    }
    if (maxPrice !== undefined && maxPrice !== '') {
      const n = Number(maxPrice);
      if (!(n >= 0)) throw bad('Maximum price must be 0 or more.');
      max = Math.round(n * 100); where.push('price_cents<=?'); args.push(max);
    }
    if (min !== null && max !== null && min > max) throw bad('Minimum price cannot be higher than maximum price.');
    if (q) { where.push('name LIKE ?'); args.push(`%${String(q).slice(0, 50)}%`); }
    const order = { price_asc: 'price_cents ASC', price_desc: 'price_cents DESC',
      name: 'name COLLATE NOCASE ASC', newest: 'id DESC' }[sort] || 'id DESC';
    return db.prepare(`
      SELECT p.*, (SELECT ROUND(AVG(rating),1) FROM reviews r WHERE r.product_id=p.id) AS avg_rating,
             (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id) AS review_count
      FROM products p WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args);
  }));

  app.get('/api/products/:id', wrap((req) => {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(req.params.id);
    if (!p) throw new HttpError(404, 'Product not found.');
    const reviews = db.prepare(`SELECT r.id, r.rating, r.comment, r.created_at, u.name AS author
      FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.id DESC`).all(p.id);
    return { ...p, reviews };
  }));

  // Stretch: only customers who bought the product may review it (one review each).
  app.post('/api/products/:id/reviews', auth, wrap((req) => {
    const p = db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(req.params.id);
    if (!p) throw new HttpError(404, 'Product not found.');
    const rating = int(req.body.rating, 'Rating', 1, 5);
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim().slice(0, 500) : '';
    const bought = db.prepare(`SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE o.user_id=? AND oi.product_id=?`).get(req.user.id, p.id);
    if (!bought) throw new HttpError(403, 'Only customers who bought this product can review it.');
    try {
      db.prepare('INSERT INTO reviews (product_id,user_id,rating,comment) VALUES (?,?,?,?)')
        .run(p.id, req.user.id, rating, comment);
    } catch { throw new HttpError(409, 'You have already reviewed this product.'); }
    return { ok: true };
  }));

  // ---------- coupons + pricing (always computed on the server) ----------
  function applyCoupon(code, subtotal) {
    const c = db.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(String(code).trim().toUpperCase());
    if (!c) throw bad('This coupon code is not valid.');
    if (new Date(`${c.expires_at}T23:59:59.999Z`) < new Date()) throw bad('This coupon has expired.');
    if (subtotal < c.min_order_cents)
      throw bad(`This coupon needs a minimum order of ₹${(c.min_order_cents / 100).toFixed(2)}.`);
    const discount = c.type === 'percent' ? Math.floor((subtotal * c.value) / 100) : Math.min(c.value, subtotal);
    return { code: c.code, discount };
  }

  const getCart = (userId) => db.prepare(`
    SELECT c.product_id, c.qty, p.name, p.image_url, p.price_cents, p.stock
    FROM cart_items c JOIN products p ON p.id=c.product_id
    WHERE c.user_id=? AND p.active=1 ORDER BY c.rowid`).all(userId);

  function priceCart(items, couponCode) {
    const subtotal = items.reduce((s, i) => s + i.price_cents * i.qty, 0);
    let discount = 0, coupon = null;
    if (couponCode) { const r = applyCoupon(couponCode, subtotal); discount = r.discount; coupon = r.code; }
    return { items, subtotal, discount, total: subtotal - discount, coupon };
  }

  // ---------- cart (persisted per user) ----------
  app.get('/api/cart', auth, wrap((req) => priceCart(getCart(req.user.id), req.query.coupon)));

  app.put('/api/cart/:productId', auth, wrap((req) => {
    const qty = int(req.body.qty, 'Quantity', 0, 99);
    const p = db.prepare('SELECT id,name,stock FROM products WHERE id=? AND active=1').get(req.params.productId);
    if (!p) throw new HttpError(404, 'Product not found.');
    if (qty === 0) db.prepare('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(req.user.id, p.id);
    else {
      if (qty > p.stock) throw new HttpError(409, p.stock === 0 ? `"${p.name}" is out of stock.` : `Only ${p.stock} of "${p.name}" left in stock.`);
      db.prepare(`INSERT INTO cart_items (user_id,product_id,qty) VALUES (?,?,?)
        ON CONFLICT(user_id,product_id) DO UPDATE SET qty=excluded.qty`).run(req.user.id, p.id, qty);
    }
    return priceCart(getCart(req.user.id));
  }));

  app.delete('/api/cart/:productId', auth, wrap((req) => {
    db.prepare('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(req.user.id, req.params.productId);
    return priceCart(getCart(req.user.id));
  }));

  // ---------- checkout: one atomic transaction ----------
  const checkout = db.transaction((userId, couponCode) => {
    const items = getCart(userId);
    if (!items.length) throw bad('Your cart is empty.');
    const priced = priceCart(items, couponCode);
    // Conditional UPDATE: succeeds only if enough stock remains, so stock can never go below zero,
    // even if two customers buy the last item at the same moment.
    const dec = db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND stock>=?');
    for (const it of items) {
      if (dec.run(it.qty, it.product_id, it.qty).changes === 0)
        throw new HttpError(409, `Sorry, "${it.name}" no longer has enough stock for ${it.qty} item(s). Please update your cart.`);
    }
    const { lastInsertRowid: orderId } = db.prepare(`INSERT INTO orders
      (user_id,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,?)`)
      .run(userId, priced.subtotal, priced.discount, priced.total, priced.coupon);
    const ins = db.prepare('INSERT INTO order_items (order_id,product_id,name,price_cents,qty) VALUES (?,?,?,?,?)');
    for (const it of items) ins.run(orderId, it.product_id, it.name, it.price_cents, it.qty);
    db.prepare('DELETE FROM cart_items WHERE user_id=?').run(userId);
    return orderId;
  });

  const withItems = (orders) => {
    const q = db.prepare('SELECT product_id,name,price_cents,qty FROM order_items WHERE order_id=?');
    return orders.map((o) => ({ ...o, items: q.all(o.id) }));
  };

  // NOTE: the body is ignored except for the coupon code. Prices/totals are never trusted from the browser.
  app.post('/api/checkout', auth, wrap((req) => {
    const code = typeof req.body.coupon === 'string' && req.body.coupon.trim() ? req.body.coupon : null;
    const id = checkout(req.user.id, code);
    return withItems([db.prepare('SELECT * FROM orders WHERE id=?').get(id)])[0];
  }));

  app.get('/api/orders', auth, wrap((req) =>
    withItems(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC').all(req.user.id))));

  // ---------- admin ----------
  app.get('/api/admin/products', adminOnly, wrap(() =>
    db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id DESC').all()));

  const readProduct = (b) => ({
    name: str(b.name, 'Name', 2, 100),
    description: typeof b.description === 'string' ? b.description.trim().slice(0, 1000) : '',
    image_url: typeof b.image_url === 'string' ? b.image_url.trim().slice(0, 500) : '',
    category: str(b.category, 'Category', 2, 40),
    price_cents: money(b.price, 'Price'),
    stock: int(b.stock, 'Stock', 0, 100000),
  });

  app.post('/api/admin/products', adminOnly, wrap((req, res) => {
    const p = readProduct(req.body);
    const info = db.prepare(`INSERT INTO products (name,description,image_url,category,price_cents,stock)
      VALUES (@name,@description,@image_url,@category,@price_cents,@stock)`).run(p);
    res.status(201);
    return { id: info.lastInsertRowid, ...p };
  }));

  app.put('/api/admin/products/:id', adminOnly, wrap((req) => {
    const p = readProduct(req.body);
    const info = db.prepare(`UPDATE products SET name=@name,description=@description,image_url=@image_url,
      category=@category,price_cents=@price_cents,stock=@stock WHERE id=@id AND active=1`).run({ ...p, id: req.params.id });
    if (!info.changes) throw new HttpError(404, 'Product not found.');
    return { id: Number(req.params.id), ...p };
  }));

  // Soft delete so past orders keep their history.
  app.delete('/api/admin/products/:id', adminOnly, wrap((req) => {
    const info = db.prepare('UPDATE products SET active=0 WHERE id=? AND active=1').run(req.params.id);
    if (!info.changes) throw new HttpError(404, 'Product not found.');
    db.prepare('DELETE FROM cart_items WHERE product_id=?').run(req.params.id);
    return { ok: true };
  }));

  // Stretch: low-stock alerts
  app.get('/api/admin/low-stock', adminOnly, wrap(() => ({
    threshold: lowStock,
    products: db.prepare('SELECT id,name,stock FROM products WHERE active=1 AND stock<=? ORDER BY stock,name').all(lowStock),
  })));

  app.get('/api/admin/orders', adminOnly, wrap(() =>
    withItems(db.prepare(`SELECT o.*, u.name AS customer, u.email FROM orders o
      JOIN users u ON u.id=o.user_id ORDER BY o.id DESC`).all())));

  app.patch('/api/admin/orders/:id/status', adminOnly, wrap((req) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) throw new HttpError(404, 'Order not found.');
    const next = NEXT_STATUS[o.status];
    if (!next) throw bad('This order is already Delivered.');
    if (req.body.status !== next) throw bad(`Orders move Placed → Shipped → Delivered. The next status for this order is "${next}".`);
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(next, o.id);
    return { id: o.id, status: next };
  }));

  app.get('/api/admin/coupons', adminOnly, wrap(() => db.prepare('SELECT * FROM coupons ORDER BY id DESC').all()));

  app.post('/api/admin/coupons', adminOnly, wrap((req, res) => {
    const code = str(req.body.code, 'Code', 3, 20).toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(code)) throw bad('Code can only contain letters, numbers, - and _.');
    const type = req.body.type;
    if (!['percent', 'flat'].includes(type)) throw bad('Type must be "percent" or "flat".');
    const value = type === 'percent' ? int(req.body.value, 'Percentage', 1, 100) : money(req.body.value, 'Flat amount');
    const minOrder = req.body.minOrder === '' || req.body.minOrder == null ? 0 : money(req.body.minOrder, 'Minimum order');
    const expires = str(req.body.expiresAt, 'Expiry date', 10, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || isNaN(new Date(expires))) throw bad('Expiry date must look like YYYY-MM-DD.');
    try {
      db.prepare('INSERT INTO coupons (code,type,value,min_order_cents,expires_at) VALUES (?,?,?,?,?)')
        .run(code, type, value, minOrder, expires);
    } catch { throw new HttpError(409, 'A coupon with this code already exists.'); }
    res.status(201);
    return { ok: true };
  }));

  // ---------- static frontend + errors ----------
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

module.exports = { createApp };
