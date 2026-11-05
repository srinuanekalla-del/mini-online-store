# Mini Online Store

A small full-stack online store: product catalogue with filters and sorting, a per-user saved cart, checkout that creates orders and reduces stock, coupon codes, order history, and an admin panel.

**Stack:** Node.js + Express (API) · SQLite via `better-sqlite3` (database) · vanilla HTML/CSS/JS frontend served by the same Express app · JWT auth · `node:test` for tests.

## How to set up and run

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env      # then set JWT_SECRET to any long random string
npm run seed              # creates the database with demo users, products and coupons
npm start                 # http://localhost:3000
npm test                  # runs the automated tests (uses an in-memory DB)
```

### Demo logins

| Role     | Email                | Password       |
|----------|----------------------|----------------|
| Admin    | admin@store.test     | Admin@123      |
| Customer | customer@store.test  | Customer@123   |

### Demo coupons

| Code        | Rule                                  |
|-------------|---------------------------------------|
| `WELCOME10` | 10% off, minimum order ₹500           |
| `FLAT200`   | ₹200 off, minimum order ₹1500         |
| `OLD5`      | Expired on purpose, shows the error   |

Settings are listed in `.env.example` (`PORT`, `JWT_SECRET`, `DB_FILE`, `LOW_STOCK_THRESHOLD`). No secrets are committed; `.env` is git-ignored.

## Features

- **Catalogue:** images, category, price, stock; filter by category, price range and name; sort by price or name.
- **Cart:** saved in the database per logged-in user, so it survives logout and works across devices.
- **Checkout:** creates an order and reduces stock. No real payment.
- **Coupons:** percentage or flat discount, minimum order value, expiry date. Admins can add coupons.
- **Orders:** customers see their order history; admin moves orders Placed → Shipped → Delivered (steps cannot be skipped).
- **Admin:** add, edit and remove products; view all orders; manage coupons.
- **Stretch:** product reviews (only from customers who bought the product, one each) and low-stock alerts in the admin panel.
- **Responsive:** works on phone and laptop screens.

## Data model

```
users(id, name, email*, password_hash, role)
products(id, name, description, image_url, category, price_cents, stock >= 0, active)
cart_items(user_id, product_id, qty)               PK(user_id, product_id)
coupons(id, code*, type percent|flat, value, min_order_cents, expires_at, active)
orders(id, user_id, status, subtotal_cents, discount_cents, total_cents, coupon_code)
order_items(id, order_id, product_id, name, price_cents, qty)   <- snapshot of what was bought
reviews(id, product_id, user_id, rating 1-5, comment)           UNIQUE(product_id, user_id)
```

## Main design decisions

- **Stock never goes negative.** Checkout runs in one database transaction. Each item is reduced with `UPDATE ... SET stock = stock - ? WHERE id = ? AND stock >= ?`. If that updates zero rows, the whole transaction rolls back and the customer gets a clear message. SQLite also has a `CHECK (stock >= 0)` constraint as a second safety net. A test covers two customers buying the last item.
- **Totals are calculated only on the server.** The checkout endpoint ignores any prices or totals sent by the browser and recomputes everything from the database (a test proves this). Coupons are validated again at checkout.
- **Money is stored as integers** (paise) to avoid floating-point errors.
- **Order items are snapshots** (name and price at purchase time), so later price changes or product removal do not rewrite history. Products are soft-deleted (`active = 0`) for the same reason.
- **Server-side validation on every input** (types, lengths, ranges, email format, price/stock rules, status transitions). Errors return `{ "error": "..." }` with a proper HTTP status, and the UI shows them as messages.
- **Auth:** passwords hashed with bcrypt; JWT sent in the `Authorization` header; admin routes check the role on the server.
- **XSS:** all user-provided text is escaped before it is put into the page.

## API overview

```
POST /api/auth/register | /api/auth/login        GET /api/me
GET  /api/products?category&minPrice&maxPrice&sort&q     GET /api/products/:id     GET /api/categories
POST /api/products/:id/reviews
GET  /api/cart[?coupon=CODE]   PUT /api/cart/:productId {qty}   DELETE /api/cart/:productId
POST /api/checkout {coupon?}   GET /api/orders
Admin: /api/admin/products (GET, POST, PUT/:id, DELETE/:id) · /api/admin/orders · PATCH /api/admin/orders/:id/status
       /api/admin/low-stock · /api/admin/coupons (GET, POST)
```

## What is finished, what is not, and what I would do with more time

**Finished:** every core feature and both stretch items listed above, plus 10 automated tests.

**Not done / limitations:**
- Images are URLs (seed data uses picsum.photos placeholders); there is no image upload.
- No pagination on the product list or admin tables.
- Single address-less checkout; no payment, email or password reset.
- JWT is kept in `localStorage`; a production app would prefer an httpOnly cookie plus CSRF protection.
- No rate limiting on login.

**With more time:** pagination, image upload, order cancellation that restores stock, coupon usage limits, rate limiting, end-to-end browser tests, deployment with a live demo link.

## AI tools used

(Edit this section to describe your own usage honestly.) I used Claude to help generate the first version of the code and tests, then I reviewed, ran and tested it myself.
