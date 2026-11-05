require('dotenv').config();
const bcrypt = require('bcryptjs');
const { openDb } = require('./db');

const img = (s) => `https://picsum.photos/seed/${encodeURIComponent(s)}/480/360`;
// [name, category, price in rupees, stock, description]
const PRODUCTS = [
  ['Wireless Earbuds', 'Electronics', 2499, 25, 'Bluetooth 5.3, 24-hour battery with case.'],
  ['Smart Watch', 'Electronics', 3999, 12, 'Heart-rate, sleep tracking and 7-day battery.'],
  ['Bluetooth Speaker', 'Electronics', 1799, 18, 'Water-resistant speaker with deep bass.'],
  ['Power Bank 20000mAh', 'Electronics', 1299, 4, 'Fast charging, dual USB-C ports.'],
  ['Cotton T-Shirt', 'Fashion', 599, 60, 'Soft 100% cotton, regular fit.'],
  ['Denim Jacket', 'Fashion', 2799, 10, 'Classic mid-wash denim jacket.'],
  ['Running Shoes', 'Fashion', 3499, 15, 'Lightweight, breathable mesh trainers.'],
  ['Everyday Backpack', 'Fashion', 1499, 3, '25L backpack with laptop sleeve.'],
  ['Ceramic Mug Set', 'Home', 799, 30, 'Set of four 300ml stoneware mugs.'],
  ['LED Desk Lamp', 'Home', 999, 22, 'Dimmable lamp with three colour modes.'],
  ['Cotton Bedsheet', 'Home', 1299, 14, 'Double bedsheet with two pillow covers.'],
  ['Wall Clock', 'Home', 899, 9, 'Silent-sweep 30cm wall clock.'],
  ['Atomic Habits', 'Books', 499, 40, 'Small changes, remarkable results.'],
  ['Deep Work', 'Books', 549, 0, 'Rules for focused success in a distracted world.'],
];

function seed(db) {
  db.exec(`DELETE FROM reviews; DELETE FROM order_items; DELETE FROM orders; DELETE FROM cart_items;
           DELETE FROM coupons; DELETE FROM products; DELETE FROM users;
           DELETE FROM sqlite_sequence;`);
  const user = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)');
  user.run('Store Admin', 'admin@store.test', bcrypt.hashSync('Admin@123', 10), 'admin');
  user.run('Demo Customer', 'customer@store.test', bcrypt.hashSync('Customer@123', 10), 'customer');

  const prod = db.prepare(
    'INSERT INTO products (name,description,image_url,category,price_cents,stock) VALUES (?,?,?,?,?,?)'
  );
  for (const [n, c, p, s, d] of PRODUCTS) prod.run(n, d, img(n), c, p * 100, s);

  const coupon = db.prepare(
    'INSERT INTO coupons (code,type,value,min_order_cents,expires_at) VALUES (?,?,?,?,?)'
  );
  const year = new Date().getFullYear() + 1;
  coupon.run('WELCOME10', 'percent', 10, 500 * 100, `${year}-12-31`);
  coupon.run('FLAT200', 'flat', 200 * 100, 1500 * 100, `${year}-12-31`);
  coupon.run('OLD5', 'percent', 5, 0, '2020-01-01'); // expired on purpose, to demo the error
}

module.exports = { seed };

if (require.main === module) {
  const db = openDb();
  seed(db);
  console.log('Seeded. Demo logins:\n  admin@store.test / Admin@123\n  customer@store.test / Customer@123');
}
