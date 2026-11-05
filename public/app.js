/* Mini Online Store frontend: vanilla JS, hash routing, talks to /api. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '₹' + (c / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='480' height='360'%3E%3Crect width='100%25' height='100%25' fill='%23dde3ea'/%3E%3Ctext x='50%25' y='50%25' fill='%235b6b7c' font-size='24' text-anchor='middle'%3ENo image%3C/text%3E%3C/svg%3E";
const img = (u, cls = '') => `<img class="${cls}" src="${esc(u || FALLBACK)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK}'">`;

let token = localStorage.getItem('token');
let user = null;
try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch { user = null; }
let coupon = '';          // coupon applied in the cart
let filters = { q: '', category: '', minPrice: '', maxPrice: '', sort: 'newest' };

/* ---------- helpers ---------- */
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 4000);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try { res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) { setSession(null, null); renderNav(); }
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

function setSession(t, u) {
  token = t; user = u;
  if (t) { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify(u)); }
  else { localStorage.removeItem('token'); localStorage.removeItem('user'); }
}

// Run an async action; show any error as a toast instead of failing silently.
const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function renderNav() {
  const here = location.hash.split('/')[1] || '';
  const link = (h, label, key) => `<a href="#/${h}" class="${here === key ? 'on' : ''}">${label}</a>`;
  $('#nav').innerHTML = link('', 'Shop', '') +
    (user ? link('cart', 'Cart', 'cart') + link('orders', 'My orders', 'orders') : '') +
    (user?.role === 'admin' ? link('admin', 'Admin', 'admin') : '') +
    (user ? `<button id="logout">Log out (${esc(user.name.split(' ')[0])})</button>` : link('login', 'Log in', 'login'));
  $('#logout')?.addEventListener('click', () => { setSession(null, null); coupon = ''; location.hash = '#/'; route(); });
  $('#nav').classList.remove('open'); $('#menuBtn').setAttribute('aria-expanded', 'false');
}
$('#menuBtn').addEventListener('click', () => {
  const open = $('#nav').classList.toggle('open');
  $('#menuBtn').setAttribute('aria-expanded', String(open));
});

function needLogin() {
  $('#app').innerHTML = `<div class="panel empty"><h2>Please log in</h2><p>You need an account to do this.</p><a class="btn" href="#/login">Log in or sign up</a></div>`;
}

const stockBadge = (n) => n === 0 ? '<span class="badge out">Out of stock</span>' : n <= 5 ? `<span class="badge low">Only ${n} left</span>` : '<span class="badge">In stock</span>';
const stars = (r) => r ? `<span class="stars" title="${r} out of 5">${'★'.repeat(Math.round(r))}${'☆'.repeat(5 - Math.round(r))}</span> ${r}` : '<span class="muted small">No reviews yet</span>';

/* ---------- add to cart ---------- */
const addToCart = safe(async (id) => {
  if (!user) { toast('Log in to add items to your cart.', true); location.hash = '#/login'; return; }
  const cart = await api('/cart');
  const have = cart.items.find((i) => i.product_id === id)?.qty || 0;
  await api('/cart/' + id, { method: 'PUT', body: { qty: have + 1 } });
  toast('Added to cart.');
});

/* ---------- shop ---------- */
const shop = safe(async () => {
  const cats = await api('/categories');
  $('#app').innerHTML = `
    <h1>Shop</h1>
    <form class="panel row" id="filters">
      <label>Search<input name="q" value="${esc(filters.q)}" placeholder="Product name"></label>
      <label>Category<select name="category"><option value="">All</option>${cats.map((c) => `<option ${c === filters.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Min price (₹)<input name="minPrice" type="number" min="0" step="1" value="${esc(filters.minPrice)}"></label>
      <label>Max price (₹)<input name="maxPrice" type="number" min="0" step="1" value="${esc(filters.maxPrice)}"></label>
      <label>Sort by<select name="sort">${[['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['name', 'Name A–Z']]
        .map(([v, l]) => `<option value="${v}" ${v === filters.sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn">Apply</button>
      <button class="btn ghost" type="button" id="reset">Reset</button>
    </form>
    <div id="list"></div>`;
  $('#filters').addEventListener('submit', (e) => { e.preventDefault(); filters = Object.fromEntries(new FormData(e.target)); loadList(); });
  $('#reset').addEventListener('click', () => { filters = { q: '', category: '', minPrice: '', maxPrice: '', sort: 'newest' }; shop(); });
  await loadList();
});

const loadList = safe(async () => {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '')).toString();
  let products;
  try { products = await api('/products?' + qs); }
  catch (e) { $('#list').innerHTML = `<div class="alert">${esc(e.message)}</div>`; return; }
  $('#list').innerHTML = products.length ? `<div class="grid">${products.map((p) => `
    <article class="card">
      <a href="#/product/${p.id}">${img(p.image_url)}</a>
      <div class="body">
        <span class="muted small">${esc(p.category)}</span>
        <h3><a href="#/product/${p.id}" style="color:inherit;text-decoration:none">${esc(p.name)}</a></h3>
        <div class="small">${stars(p.avg_rating)}</div>
        <div class="price">${money(p.price_cents)}</div>
        <div>${stockBadge(p.stock)}</div>
        <div class="actions"><button class="btn sm" data-add="${p.id}" ${p.stock === 0 ? 'disabled' : ''}>Add to cart</button></div>
      </div>
    </article>`).join('')}</div>` : '<div class="panel empty">No products match these filters. Try widening the price range or resetting.</div>';
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addToCart(Number(b.dataset.add))));
});

/* ---------- product detail + reviews ---------- */
const productPage = safe(async (id) => {
  const p = await api('/products/' + id);
  $('#app').innerHTML = `
    <p><a href="#/">← Back to shop</a></p>
    <div class="panel detail">
      ${img(p.image_url)}
      <div>
        <span class="muted small">${esc(p.category)}</span>
        <h1>${esc(p.name)}</h1>
        <p>${esc(p.description)}</p>
        <p class="price" style="font-size:1.5rem;font-weight:700">${money(p.price_cents)}</p>
        <p>${stockBadge(p.stock)}</p>
        <button class="btn" id="add" ${p.stock === 0 ? 'disabled' : ''}>Add to cart</button>
      </div>
    </div>
    <div class="panel">
      <h2>Reviews</h2>
      ${p.reviews.length ? p.reviews.map((r) => `<div style="margin-bottom:.8rem"><span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span> <strong>${esc(r.author)}</strong>
        <div>${esc(r.comment)}</div></div>`).join('') : '<p class="muted">No reviews yet.</p>'}
      ${user ? `<form id="review" class="row" style="margin-top:1rem">
        <label>Rating<select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} star${n > 1 ? 's' : ''}</option>`).join('')}</select></label>
        <label style="flex:3 1 220px">Comment<input name="comment" maxlength="500" placeholder="What did you think?"></label>
        <button class="btn">Post review</button></form>
        <p class="muted small">Only customers who bought this product can review it.</p>` : '<p class="muted small">Log in to review products you have bought.</p>'}
    </div>`;
  $('#add').addEventListener('click', () => addToCart(p.id));
  $('#review')?.addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await api(`/products/${p.id}/reviews`, { method: 'POST', body: f });
    toast('Thanks for your review!'); productPage(id);
  }));
});

/* ---------- auth ---------- */
function loginPage() {
  $('#app').innerHTML = `
    <div class="two">
      <form class="panel" id="login"><h2>Log in</h2>
        <label>Email<input name="email" type="email" required autocomplete="email"></label><br>
        <label>Password<input name="password" type="password" required autocomplete="current-password"></label><br>
        <button class="btn">Log in</button>
        <p class="muted small">Demo: customer@store.test / Customer@123 &nbsp;|&nbsp; admin@store.test / Admin@123</p>
      </form>
      <form class="panel" id="register"><h2>Create account</h2>
        <label>Name<input name="name" required minlength="2" autocomplete="name"></label><br>
        <label>Email<input name="email" type="email" required autocomplete="email"></label><br>
        <label>Password (8+ characters)<input name="password" type="password" required minlength="8" autocomplete="new-password"></label><br>
        <button class="btn">Sign up</button>
      </form>
    </div>`;
  for (const kind of ['login', 'register']) {
    $('#' + kind).addEventListener('submit', safe(async (e) => {
      e.preventDefault();
      const r = await api('/auth/' + kind, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      setSession(r.token, r.user); toast(`Welcome, ${r.user.name}!`);
      location.hash = '#/'; route();
    }));
  }
}

/* ---------- cart + checkout ---------- */
const cartPage = safe(async () => {
  if (!user) return needLogin();
  let cart;
  try { cart = await api('/cart' + (coupon ? '?coupon=' + encodeURIComponent(coupon) : '')); }
  catch (e) { if (!coupon) throw e; toast(e.message, true); coupon = ''; cart = await api('/cart'); }
  if (!cart.items.length) { $('#app').innerHTML = '<div class="panel empty"><h2>Your cart is empty</h2><a class="btn" href="#/">Browse products</a></div>'; return; }
  $('#app').innerHTML = `
    <h1>Your cart</h1>
    <div class="panel table-wrap"><table>
      <thead><tr><th></th><th>Product</th><th>Price</th><th>Qty</th><th>Total</th><th></th></tr></thead>
      <tbody>${cart.items.map((i) => `<tr>
        <td>${img(i.image_url, 'thumb')}</td>
        <td>${esc(i.name)}<div class="small muted">${i.stock} in stock</div></td>
        <td>${money(i.price_cents)}</td>
        <td><input class="qty" type="number" min="1" max="${Math.min(99, i.stock)}" value="${i.qty}" data-qty="${i.product_id}" aria-label="Quantity for ${esc(i.name)}"></td>
        <td>${money(i.price_cents * i.qty)}</td>
        <td><button class="btn danger sm" data-rm="${i.product_id}">Remove</button></td></tr>`).join('')}</tbody></table></div>
    <div class="two">
      <form class="panel" id="couponForm"><h3>Coupon code</h3>
        <div class="row"><input name="code" value="${esc(coupon)}" placeholder="e.g. WELCOME10" style="flex:1" aria-label="Coupon code">
        <button class="btn ghost">Apply</button>${coupon ? '<button type="button" class="btn danger" id="rmCoupon">Remove</button>' : ''}</div>
        ${cart.coupon ? `<p class="small" style="color:var(--ok)">${esc(cart.coupon)} applied.</p>` : ''}
      </form>
      <div class="panel totals">
        <div><span>Subtotal</span><span>${money(cart.subtotal)}</span></div>
        <div><span>Discount</span><span>−${money(cart.discount)}</span></div>
        <div class="grand"><span>Total</span><span>${money(cart.total)}</span></div>
        <p class="small muted">No real payment is needed. Totals are calculated by the server.</p>
        <button class="btn" id="checkout" style="width:100%">Place order</button>
      </div>
    </div>`;
  document.querySelectorAll('[data-qty]').forEach((el) => el.addEventListener('change', safe(async () => {
    try { await api('/cart/' + el.dataset.qty, { method: 'PUT', body: { qty: el.value } }); }
    catch (e) { toast(e.message, true); }
    cartPage();
  })));
  document.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', safe(async () => { await api('/cart/' + b.dataset.rm, { method: 'DELETE' }); cartPage(); })));
  $('#couponForm').addEventListener('submit', (e) => { e.preventDefault(); coupon = new FormData(e.target).get('code').trim(); cartPage(); });
  $('#rmCoupon')?.addEventListener('click', () => { coupon = ''; cartPage(); });
  $('#checkout').addEventListener('click', safe(async (e) => {
    e.target.disabled = true;
    try {
      const o = await api('/checkout', { method: 'POST', body: { coupon: coupon || null } });
      coupon = ''; toast(`Order #${o.id} placed!`); location.hash = '#/orders';
    } catch (err) { toast(err.message, true); e.target.disabled = false; cartPage(); }
  }));
});

/* ---------- order history ---------- */
const ordersPage = safe(async () => {
  if (!user) return needLogin();
  const orders = await api('/orders');
  $('#app').innerHTML = '<h1>My orders</h1>' + (orders.length ? orders.map((o) => `
    <div class="panel">
      <div class="spread"><strong>Order #${o.id}</strong><span class="badge ${o.status}">${o.status}</span></div>
      <div class="muted small">${esc(o.created_at)} UTC${o.coupon_code ? ' · coupon ' + esc(o.coupon_code) : ''}</div>
      <div class="table-wrap"><table><tbody>${o.items.map((i) => `<tr><td><a href="#/product/${i.product_id}">${esc(i.name)}</a></td><td>× ${i.qty}</td><td>${money(i.price_cents * i.qty)}</td></tr>`).join('')}</tbody></table></div>
      <div class="totals"><div><span>Subtotal</span><span>${money(o.subtotal_cents)}</span></div>
      <div><span>Discount</span><span>−${money(o.discount_cents)}</span></div>
      <div class="grand"><span>Total</span><span>${money(o.total_cents)}</span></div></div>
    </div>`).join('') : '<div class="panel empty">No orders yet. <a href="#/">Start shopping</a></div>');
});

/* ---------- admin ---------- */
const adminPage = safe(async () => {
  if (user?.role !== 'admin') { $('#app').innerHTML = '<div class="panel empty"><h2>Admins only</h2></div>'; return; }
  const [products, orders, low, coupons] = await Promise.all([api('/admin/products'), api('/admin/orders'), api('/admin/low-stock'), api('/admin/coupons')]);
  $('#app').innerHTML = `
    <h1>Admin panel</h1>
    ${low.products.length ? `<div class="alert"><strong>Low stock (${low.threshold} or fewer):</strong> ${low.products.map((p) => `${esc(p.name)} (${p.stock})`).join(', ')}</div>` : ''}

    <div class="panel"><h2 id="formTitle">Add product</h2>
      <form id="pform" class="row">
        <input type="hidden" name="pid">
        <label>Name<input name="name" required></label>
        <label>Category<input name="category" required list="cats"></label>
        <label>Price (₹)<input name="price" type="number" step="0.01" min="0.01" required></label>
        <label>Stock<input name="stock" type="number" min="0" step="1" required></label>
        <label style="flex:2 1 220px">Image URL<input name="image_url" placeholder="https://..."></label>
        <label style="flex:2 1 220px">Description<input name="description"></label>
        <button class="btn">Save product</button><button class="btn ghost" type="button" id="cancelEdit">Clear</button>
      </form><datalist id="cats">${[...new Set(products.map((p) => p.category))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>

    <div class="panel"><h2>Products</h2><div class="table-wrap"><table>
      <thead><tr><th></th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th></th></tr></thead>
      <tbody>${products.map((p) => `<tr><td>${img(p.image_url, 'thumb')}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${money(p.price_cents)}</td>
        <td>${p.stock} ${p.stock <= low.threshold ? '<span class="badge low">low</span>' : ''}</td>
        <td><button class="btn ghost sm" data-edit="${p.id}">Edit</button> <button class="btn danger sm" data-del="${p.id}">Delete</button></td></tr>`).join('')}</tbody></table></div></div>

    <div class="panel"><h2>Orders</h2>${orders.length ? `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${orders.map((o) => {
        const next = { Placed: 'Shipped', Shipped: 'Delivered' }[o.status];
        return `<tr><td>${o.id}</td><td>${esc(o.customer)}<div class="small muted">${esc(o.email)}</div></td>
          <td class="small">${o.items.map((i) => `${esc(i.name)} × ${i.qty}`).join('<br>')}</td><td>${money(o.total_cents)}</td>
          <td><span class="badge ${o.status}">${o.status}</span></td>
          <td>${next ? `<button class="btn sm" data-ship="${o.id}" data-next="${next}">Mark ${next}</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">No orders yet.</p>'}</div>

    <div class="panel"><h2>Coupons</h2>
      <form id="cform" class="row">
        <label>Code<input name="code" required maxlength="20"></label>
        <label>Type<select name="type"><option value="percent">Percent</option><option value="flat">Flat (₹)</option></select></label>
        <label>Value<input name="value" type="number" step="0.01" min="1" required></label>
        <label>Min order (₹)<input name="minOrder" type="number" step="0.01" min="0"></label>
        <label>Expires<input name="expiresAt" type="date" required></label>
        <button class="btn">Add coupon</button></form>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Min order</th><th>Expires</th></tr></thead>
      <tbody>${coupons.map((c) => `<tr><td>${esc(c.code)}</td><td>${c.type === 'percent' ? c.value + '%' : money(c.value)}</td><td>${money(c.min_order_cents)}</td><td>${esc(c.expires_at)}</td></tr>`).join('')}</tbody></table></div></div>`;

  const form = $('#pform');
  const clear = () => { form.reset(); form.elements.pid.value = ''; $('#formTitle').textContent = 'Add product'; };
  $('#cancelEdit').addEventListener('click', clear);
  form.addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form)); const id = f.pid; delete f.pid;
    await api('/admin/products' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: f });
    toast(id ? 'Product updated.' : 'Product added.'); adminPage();
  }));
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const p = products.find((x) => x.id === Number(b.dataset.edit));
    const el = form.elements;
    el.pid.value = p.id; el.name.value = p.name; el.category.value = p.category; el.price.value = p.price_cents / 100;
    el.stock.value = p.stock; el.image_url.value = p.image_url; el.description.value = p.description;
    $('#formTitle').textContent = 'Edit product #' + p.id; scrollTo({ top: 0, behavior: 'smooth' });
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', safe(async () => {
    if (!confirm('Remove this product from the store?')) return;
    await api('/admin/products/' + b.dataset.del, { method: 'DELETE' }); toast('Product removed.'); adminPage();
  })));
  document.querySelectorAll('[data-ship]').forEach((b) => b.addEventListener('click', safe(async () => {
    await api(`/admin/orders/${b.dataset.ship}/status`, { method: 'PATCH', body: { status: b.dataset.next } });
    toast('Order updated.'); adminPage();
  })));
  $('#cform').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.type === 'percent') f.value = Number(f.value); // server expects whole percent; flat is in rupees
    await api('/admin/coupons', { method: 'POST', body: f }); toast('Coupon added.'); adminPage();
  }));
});

/* ---------- router ---------- */
function route() {
  const [, page, arg] = location.hash.slice(1).split('/');
  renderNav(); scrollTo(0, 0);
  if (page === 'product') return productPage(arg);
  if (page === 'login') return loginPage();
  if (page === 'cart') return cartPage();
  if (page === 'orders') return ordersPage();
  if (page === 'admin') return adminPage();
  return shop();
}
addEventListener('hashchange', route);
route();
