const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

let server, base, db, n = 0;

test.before(async () => {
  db = openDb(':memory:');
  seed(db);
  const app = createApp(db, { jwtSecret: 'test-secret' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections?.(); server.close(); });

async function call(method, path, body, token) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const newUser = async () => {
  const r = await call('POST', '/auth/register', { name: 'Test User', email: `t${++n}@x.test`, password: 'password123' });
  return r.body.token;
};
const adminToken = async () => (await call('POST', '/auth/login', { email: 'admin@store.test', password: 'Admin@123' })).body.token;
const pid = (name) => db.prepare('SELECT id FROM products WHERE name=?').get(name).id;
const stockOf = (id) => db.prepare('SELECT stock FROM products WHERE id=?').get(id).stock;
const addProduct = (name, stock, price = 100) =>
  db.prepare('INSERT INTO products (name,category,price_cents,stock) VALUES (?,?,?,?)').run(name, 'Test', price * 100, stock).lastInsertRowid;

test('cart requires login, and register validates input', async () => {
  assert.equal((await call('GET', '/cart')).status, 401);
  const bad = await call('POST', '/auth/register', { name: 'A', email: 'nope', password: 'short' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Name|email|Password/i);
});

test('product listing filters by category and price range, and sorts', async () => {
  const r = await call('GET', '/products?category=Electronics&minPrice=1500&maxPrice=3000&sort=price_asc');
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  assert.ok(r.body.every((p) => p.category === 'Electronics' && p.price_cents >= 150000 && p.price_cents <= 300000));
  const prices = r.body.map((p) => p.price_cents);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.equal((await call('GET', '/products?minPrice=500&maxPrice=100')).status, 400);
});

test('checkout creates an order, reduces stock and clears the cart', async () => {
  const t = await newUser();
  const id = pid('Cotton T-Shirt');
  const before = stockOf(id);
  await call('PUT', `/cart/${id}`, { qty: 3 }, t);
  const order = await call('POST', '/checkout', {}, t);
  assert.equal(order.status, 200);
  assert.equal(order.body.status, 'Placed');
  assert.equal(order.body.total_cents, 3 * 59900);
  assert.equal(stockOf(id), before - 3);
  assert.equal((await call('GET', '/cart', null, t)).body.items.length, 0);
  assert.equal((await call('GET', '/orders', null, t)).body.length, 1);
});

test('stock never goes negative when two customers buy the last item', async () => {
  const id = addProduct('Last One', 1);
  const a = await newUser(), b = await newUser();
  assert.equal((await call('PUT', `/cart/${id}`, { qty: 1 }, a)).status, 200);
  assert.equal((await call('PUT', `/cart/${id}`, { qty: 1 }, b)).status, 200);
  const first = await call('POST', '/checkout', {}, a);
  const second = await call('POST', '/checkout', {}, b);
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.match(second.body.error, /stock/i);
  assert.equal(stockOf(id), 0);
  // the failed checkout must roll back completely: no order for b
  assert.equal((await call('GET', '/orders', null, b)).body.length, 0);
});

test('cannot add more than the available stock to the cart', async () => {
  const id = addProduct('Scarce', 2);
  const t = await newUser();
  const r = await call('PUT', `/cart/${id}`, { qty: 5 }, t);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Only 2/);
});

test('totals are calculated on the server; client-sent prices are ignored', async () => {
  const t = await newUser();
  const id = addProduct('Priced', 10, 200);
  await call('PUT', `/cart/${id}`, { qty: 2 }, t);
  const r = await call('POST', '/checkout', { total: 1, total_cents: 1, price_cents: 1, items: [{ product_id: id, price_cents: 1, qty: 1 }] }, t);
  assert.equal(r.body.total_cents, 40000);
  assert.equal(r.body.items[0].qty, 2);
});

test('coupons: percentage, flat, minimum order and expiry rules', async () => {
  const t = await newUser();
  const id = addProduct('Coupon Item', 10, 1000);
  await call('PUT', `/cart/${id}`, { qty: 1 }, t); // subtotal ₹1000

  const pct = await call('GET', '/cart?coupon=welcome10', null, t); // case-insensitive
  assert.equal(pct.body.discount, 10000);
  assert.equal(pct.body.total, 90000);

  const tooSmall = await call('GET', '/cart?coupon=FLAT200', null, t); // needs ₹1500
  assert.equal(tooSmall.status, 400);
  assert.match(tooSmall.body.error, /minimum order/i);

  await call('PUT', `/cart/${id}`, { qty: 2 }, t); // subtotal ₹2000
  assert.equal((await call('GET', '/cart?coupon=FLAT200', null, t)).body.total, 180000);

  const expired = await call('GET', '/cart?coupon=OLD5', null, t);
  assert.equal(expired.status, 400);
  assert.match(expired.body.error, /expired/i);
  assert.equal((await call('GET', '/cart?coupon=NOPE', null, t)).status, 400);
});

test('admin endpoints are protected and order status follows Placed → Shipped → Delivered', async () => {
  const cust = await newUser();
  assert.equal((await call('GET', '/admin/orders', null, cust)).status, 403);
  assert.equal((await call('POST', '/admin/products', { name: 'X' }, cust)).status, 403);

  const id = addProduct('Ship Me', 5);
  await call('PUT', `/cart/${id}`, { qty: 1 }, cust);
  const order = (await call('POST', '/checkout', {}, cust)).body;

  const admin = await adminToken();
  const skip = await call('PATCH', `/admin/orders/${order.id}/status`, { status: 'Delivered' }, admin);
  assert.equal(skip.status, 400); // cannot skip Shipped
  assert.equal((await call('PATCH', `/admin/orders/${order.id}/status`, { status: 'Shipped' }, admin)).status, 200);
  assert.equal((await call('PATCH', `/admin/orders/${order.id}/status`, { status: 'Delivered' }, admin)).status, 200);
  assert.equal((await call('PATCH', `/admin/orders/${order.id}/status`, { status: 'Shipped' }, admin)).status, 400);
});

test('admin product validation rejects bad input; low-stock alert lists scarce items', async () => {
  const admin = await adminToken();
  const bad = await call('POST', '/admin/products', { name: 'Bad', category: 'Test', price: -5, stock: 3 }, admin);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Price/);
  const ok = await call('POST', '/admin/products', { name: 'Good Item', category: 'Test', price: 49.5, stock: 2 }, admin);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.price_cents, 4950);
  const low = await call('GET', '/admin/low-stock', null, admin);
  assert.ok(low.body.products.some((p) => p.name === 'Good Item'));
});

test('only customers who bought a product can review it (once)', async () => {
  const t = await newUser();
  const id = addProduct('Reviewable', 5);
  const denied = await call('POST', `/products/${id}/reviews`, { rating: 5, comment: 'great' }, t);
  assert.equal(denied.status, 403);
  await call('PUT', `/cart/${id}`, { qty: 1 }, t);
  await call('POST', '/checkout', {}, t);
  assert.equal((await call('POST', `/products/${id}/reviews`, { rating: 5, comment: 'great' }, t)).status, 200);
  assert.equal((await call('POST', `/products/${id}/reviews`, { rating: 4 }, t)).status, 409);
  assert.equal((await call('GET', `/products/${id}`)).body.reviews.length, 1);
});
