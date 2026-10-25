// End-to-end API checks. Run: npm test  (starts the app on a temp DB and port)
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'studio-test-' + Date.now() + '.db');
process.env.JWT_SECRET = 'test';
const assert = require('assert');
const app = require('./server');
const srv = app.listen(0, async () => {
  const base = 'http://localhost:' + srv.address().port;
  const call = async (m, p, tok, body) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, b: await r.json().catch(() => ({})) };
  };
  const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const eq = (got, want, label) => { assert.strictEqual(got, want, label + ` (got ${got})`); console.log('ok -', label); };
  try {
    eq((await call('GET', '/api/paintings')).s, 401, 'no token -> 401');
    const admin = (await call('POST', '/api/login', null, { email: 'studio@artstudio.in', password: 'Studio@123' })).b.token;
    const a = (await call('POST', '/api/signup', null, { email: 'a@x.com', password: 'secret1' })).b.token;
    const b = (await call('POST', '/api/signup', null, { email: 'b@x.com', password: 'secret1' })).b.token;
    eq((await call('POST', '/api/paintings', a, { title: 't', price: 5 })).s, 403, 'customer cannot add painting -> 403');
    const p = (await call('POST', '/api/paintings', admin, { title: 'New', price: 99 })).b;
    eq((await call('POST', '/api/orders', admin, { painting_id: p.id })).s, 403, 'admin cannot buy -> 403');
    // race: 5 concurrent buyers, exactly one wins
    const rs = await Promise.all([a, b, a, b, a].map(t => call('POST', '/api/orders', t, { painting_id: p.id })));
    eq(rs.filter(r => r.s === 201).length, 1, 'concurrent buy: exactly one succeeds');
    eq(rs.filter(r => r.s === 409).length, 4, 'concurrent buy: others get 409');
    eq((await call('PUT', '/api/paintings/' + p.id, admin, { title: 'x', price: 1 })).s, 409, 'cannot edit sold painting');
    const order = rs.find(r => r.s === 201).b, owner = rs.find(r => r.s === 201).b.customer_email === 'a@x.com' ? a : b, other = owner === a ? b : a;
    eq((await call('POST', `/api/orders/${order.id}/cancel`, other)).s, 404, "other's order -> 404");
    eq((await call('POST', `/api/orders/${order.id}/cancel`, owner)).s, 200, 'owner cancels order');
    eq((await call('GET', '/api/paintings', a)).b.find(x => x.id === p.id).status, 'available', 'painting available again');
    // bookings
    eq((await call('POST', '/api/bookings', a, { date: iso(6), wall_sqft: 100, address: 'x' })).s, 400, 'date 6 days away rejected');
    eq((await call('POST', '/api/bookings', a, { date: iso(91), wall_sqft: 100, address: 'x' })).s, 400, 'date 91 days away rejected');
    eq((await call('POST', '/api/bookings', a, { date: iso(10), wall_sqft: 9, address: 'x' })).s, 400, 'size 9 rejected');
    eq((await call('POST', '/api/bookings', a, { date: iso(10), wall_sqft: 501, address: 'x' })).s, 400, 'size 501 rejected');
    const bk = await Promise.all([a, b, a, b].map(t => call('POST', '/api/bookings', t, { date: iso(10), wall_sqft: 100, address: 'addr' })));
    eq(bk.filter(r => r.s === 201).length, 1, 'concurrent booking same date: one wins');
    const bw = bk.find(r => r.s === 201).b;
    eq(bw.price, 100 * 150, 'price = sqft * rate');
    eq((await call('POST', `/api/bookings/${bw.id}/confirm`, admin)).b.status, 'confirmed', 'admin confirms');
    eq((await call('POST', `/api/bookings/${bw.id}/confirm`, admin)).s, 409, 'cannot decide twice');
    eq((await call('POST', `/api/bookings/${bw.id}/confirm`, a)).s, 403, 'customer cannot confirm -> 403');
    const bOwner = bw.customer_email === 'a@x.com' ? a : b;
    eq((await call('POST', `/api/bookings/${bw.id}/cancel`, bOwner === a ? b : a)).s, 404, "other's booking -> 404");
    eq((await call('POST', `/api/bookings/${bw.id}/cancel`, admin)).s, 403, 'admin cannot cancel -> 403');
    eq((await call('POST', `/api/bookings/${bw.id}/cancel`, bOwner)).s, 200, 'owner cancels booking');
    eq((await call('POST', '/api/bookings', a, { date: iso(10), wall_sqft: 20, address: 'x' })).s, 201, 'cancelled date can be rebooked');
    const near = await call('POST', '/api/bookings', b, { date: iso(7), wall_sqft: 20, address: 'x' });
    eq(near.s, 201, 'day-7 booking ok');
    // pottery
    const good = { item: 'Kulhad (clay cup)', glaze: 'Kumkum Red', quantity: 2, needed_by: iso(14) };
    eq((await call('POST', '/api/pottery', a, { ...good, needed_by: iso(13) })).s, 400, 'needed-by 13 days rejected');
    eq((await call('POST', '/api/pottery', a, { ...good, quantity: 13 })).s, 400, 'qty 13 rejected');
    eq((await call('POST', '/api/pottery', a, { ...good, glaze: 'Nope' })).s, 400, 'unknown glaze rejected');
    const pr = (await call('POST', '/api/pottery', a, good)).b;
    eq((await call('PUT', '/api/pottery/' + pr.id, a, { ...good, quantity: 3 })).b.quantity, 3, 'edit while requested');
    eq((await call('PUT', '/api/pottery/' + pr.id, b, good)).s, 404, "other's pottery -> 404");
    eq((await call('POST', `/api/pottery/${pr.id}/accept`, admin)).b.status, 'accepted', 'admin accepts');
    eq((await call('PUT', '/api/pottery/' + pr.id, a, good)).s, 409, 'cannot edit after accepted');
    eq((await call('POST', `/api/pottery/${pr.id}/cancel`, a)).s, 409, 'cannot cancel after accepted');
    eq((await call('GET', '/api/pottery', b)).b.length, 0, 'customer sees only own pottery');
    eq((await call('GET', '/api/pottery', admin)).b.length, 1, 'admin sees all pottery');
    console.log('\nALL PASSED');
  } catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
  srv.close();
});
