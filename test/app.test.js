import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import Stripe from 'stripe';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const realStripe = new Stripe('sk_test_dummy');
const quietLog = { warn() {}, error() {}, log() {} };

// Stands in for the Stripe API; webhook signing/verification is the real SDK code.
function fakeStripe() {
  const state = { subscriptions: new Map(), checkoutSessions: new Map(), calls: [], nextCustomer: 1 };
  return {
    state,
    webhooks: realStripe.webhooks,
    customers: {
      create: async (params) => {
        state.calls.push(['customers.create', params]);
        return { id: `cus_${state.nextCustomer++}` };
      },
    },
    checkout: {
      sessions: {
        create: async (params) => {
          state.calls.push(['checkout.create', params]);
          return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' };
        },
        retrieve: async (id) => state.checkoutSessions.get(id),
      },
    },
    subscriptions: { retrieve: async (id) => state.subscriptions.get(id) },
    billingPortal: {
      sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/session/1' }) },
    },
  };
}

describe('membership site', () => {
  let server, baseUrl, stripe, db, dataDir;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sablontar-test-'));
    db = openDb(':memory:');
    stripe = fakeStripe();
    const config = {
      baseUrl: 'http://placeholder', // replaced once the port is known
      secureCookies: false,
      trustProxy: false,
      dataDir,
      siteName: 'Sablontár',
      audience: 'fodrászoknak',
      priceLabel: '4 990 Ft / hó',
      adminEmails: ['admin@example.com'],
      stripe: { secretKey: 'sk_test', priceId: 'price_123', webhookSecret: WEBHOOK_SECRET },
    };
    // Listen first: the app's CSRF check needs the final origin, which includes the port.
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    config.baseUrl = baseUrl;
    server.on('request', createApp({ config, db, stripe, log: quietLog }));
  });

  after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    stripe.state.calls.length = 0;
  });

  // --- helpers ---
  const get = (url, cookie) => fetch(baseUrl + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const post = (url, { cookie, form, body, origin = baseUrl, headers = {} } = {}) =>
    fetch(baseUrl + url, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ?? (form ? new URLSearchParams(form) : undefined),
    });
  const sessionCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('sid='))?.split(';')[0];

  async function register(email, password = 'jelszo1234') {
    const res = await post('/regisztracio', { form: { email, password } });
    assert.equal(res.status, 303);
    return sessionCookie(res);
  }

  function sendWebhook(event, secret = WEBHOOK_SECRET) {
    const payload = JSON.stringify(event);
    const signature = realStripe.webhooks.generateTestHeaderString({ payload, secret });
    return post('/webhook/stripe', {
      origin: null,
      body: payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    });
  }

  const userRow = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  async function subscribe(email) {
    const cookie = await register(email);
    await post('/elofizetes/fizetes', { cookie });
    const { id, stripe_customer_id: customer } = userRow(email);
    const subscriptionId = `sub_${id}`;
    stripe.state.subscriptions.set(subscriptionId, {
      id: subscriptionId, customer, status: 'active', items: { data: [{ current_period_end: 1_900_000_000 }] },
    });
    const res = await sendWebhook({
      id: `evt_${id}`, type: 'checkout.session.completed',
      data: { object: { id: `cs_${id}`, mode: 'subscription', client_reference_id: String(id), customer, subscription: subscriptionId } },
    });
    assert.equal(res.status, 200);
    return { cookie, customer, subscriptionId };
  }

  // --- tests ---

  test('landing page is public and shows the price', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /fodrászoknak/);
    assert.match(body, /4 990 Ft \/ hó/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  });

  test('registration logs the user in and sends them to the subscribe page', async () => {
    const cookie = await register('anna@example.com');
    assert.ok(cookie);
    const library = await get('/tagoknak', cookie);
    assert.equal(library.status, 303);
    assert.equal(library.headers.get('location'), '/elofizetes');
    const page = await get('/elofizetes', cookie);
    assert.equal(page.status, 200);
  });

  test('registration rejects duplicates, bad emails and short passwords', async () => {
    await register('dupla@example.com');
    assert.equal((await post('/regisztracio', { form: { email: 'DUPLA@example.com', password: 'jelszo1234' } })).status, 400);
    assert.equal((await post('/regisztracio', { form: { email: 'nem-email', password: 'jelszo1234' } })).status, 400);
    assert.equal((await post('/regisztracio', { form: { email: 'rovid@example.com', password: 'rovid' } })).status, 400);
  });

  test('login checks the password and logout ends the session', async () => {
    await register('bela@example.com', 'titkos-jelszo');
    const bad = await post('/belepes', { form: { email: 'bela@example.com', password: 'rossz-jelszo' } });
    assert.equal(bad.status, 400);
    assert.equal(sessionCookie(bad), undefined);

    const ok = await post('/belepes', { form: { email: 'Bela@Example.com', password: 'titkos-jelszo' } });
    assert.equal(ok.status, 303);
    const cookie = sessionCookie(ok);
    assert.equal((await get('/fiok', cookie)).status, 200);

    await post('/kilepes', { cookie });
    assert.equal((await get('/fiok', cookie)).status, 303);
  });

  test('login is rate limited after repeated failures', async () => {
    await register('limit@example.com');
    let last;
    for (let i = 0; i < 11; i++) {
      last = await post('/belepes', { form: { email: 'limit@example.com', password: 'rossz' } });
    }
    assert.equal(last.status, 429);
  });

  test('state-changing requests from another origin are rejected', async () => {
    assert.equal((await post('/regisztracio', { origin: 'https://evil.example', form: { email: 'x@example.com', password: 'jelszo1234' } })).status, 403);
    assert.equal((await post('/regisztracio', { origin: null, form: { email: 'x@example.com', password: 'jelszo1234' } })).status, 403);
  });

  test('checkout creates one Stripe customer and a subscription session for the price', async () => {
    const cookie = await register('cili@example.com');
    const res = await post('/elofizetes/fizetes', { cookie });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_1');

    const user = userRow('cili@example.com');
    const [, params] = stripe.state.calls.find(([name]) => name === 'checkout.create');
    assert.equal(params.mode, 'subscription');
    assert.deepEqual(params.line_items, [{ price: 'price_123', quantity: 1 }]);
    assert.equal(params.client_reference_id, String(user.id));
    assert.equal(params.customer, user.stripe_customer_id);

    await post('/elofizetes/fizetes', { cookie });
    assert.equal(stripe.state.calls.filter(([name]) => name === 'customers.create').length, 1);
  });

  test('webhooks with a bad signature are rejected', async () => {
    const res = await sendWebhook({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } }, 'whsec_wrong');
    assert.equal(res.status, 400);
  });

  test('a completed checkout unlocks the library; cancellation locks it again', async () => {
    const { cookie, customer, subscriptionId } = await subscribe('dora@example.com');
    const user = userRow('dora@example.com');
    assert.equal(user.subscription_status, 'active');
    assert.equal(user.current_period_end, 1_900_000_000);
    assert.equal((await get('/tagoknak', cookie)).status, 200);
    assert.equal((await post('/elofizetes/fizetes', { cookie })).headers.get('location'), '/tagoknak');

    // Event payloads are not trusted: the app re-reads the subscription from Stripe.
    stripe.state.subscriptions.get(subscriptionId).status = 'canceled';
    const res = await sendWebhook({
      id: 'evt_del', type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, customer, status: 'active' } },
    });
    assert.equal(res.status, 200);
    assert.equal(userRow('dora@example.com').subscription_status, 'canceled');
    assert.equal((await get('/tagoknak', cookie)).headers.get('location'), '/elofizetes');
  });

  test('a late event about an old subscription does not lock out a resubscribed member', async () => {
    const { cookie, customer, subscriptionId: oldSub } = await subscribe('jutka@example.com');
    stripe.state.subscriptions.get(oldSub).status = 'canceled';
    stripe.state.subscriptions.set('sub_new', { id: 'sub_new', customer, status: 'active', items: { data: [] } });
    const event = (id, sub) => ({ id, type: 'customer.subscription.updated', data: { object: { id: sub, customer } } });

    await sendWebhook(event('evt_new', 'sub_new'));
    await sendWebhook(event('evt_old_late', oldSub));
    assert.equal(userRow('jutka@example.com').stripe_subscription_id, 'sub_new');
    assert.equal((await get('/tagoknak', cookie)).status, 200);

    stripe.state.subscriptions.get('sub_new').status = 'canceled';
    await sendWebhook(event('evt_new_end', 'sub_new'));
    assert.equal(userRow('jutka@example.com').subscription_status, 'canceled');
  });

  test('the success redirect syncs the subscription even before the webhook arrives', async () => {
    const cookie = await register('emma@example.com');
    await post('/elofizetes/fizetes', { cookie });
    const { id, stripe_customer_id: customer } = userRow('emma@example.com');
    stripe.state.subscriptions.set('sub_emma', { id: 'sub_emma', customer, status: 'active', items: { data: [] } });
    stripe.state.checkoutSessions.set('cs_emma', { id: 'cs_emma', client_reference_id: String(id), customer, subscription: 'sub_emma' });

    const res = await get('/elofizetes/sikeres?session_id=cs_emma', cookie);
    assert.equal(res.headers.get('location'), '/tagoknak?udv=1');
    assert.equal((await get('/tagoknak?udv=1', cookie)).status, 200);
  });

  test("a user cannot claim someone else's checkout session", async () => {
    const cookie = await register('frida@example.com');
    stripe.state.checkoutSessions.set('cs_other', { id: 'cs_other', client_reference_id: '999999', customer: 'cus_x', subscription: 'sub_x' });
    await get('/elofizetes/sikeres?session_id=cs_other', cookie);
    assert.equal(userRow('frida@example.com').subscription_status, null);
  });

  test('admin uploads a template that members can download and others cannot', async () => {
    const adminCookie = await register('admin@example.com');
    const form = new FormData();
    form.set('title', 'Őszi akció poszt');
    form.set('category', 'Poszt');
    form.set('month', '2026-10');
    form.set('description', 'Három színváltozat');
    form.set('file', new Blob(['zip-tartalom']), 'őszi-akció.zip');
    form.set('preview', new Blob([Buffer.from('89504e47', 'hex')], { type: 'image/png' }), 'elonezet.png');
    const upload = await post('/admin/sablon', { cookie: adminCookie, body: form });
    assert.equal(upload.status, 303);

    const template = db.prepare("SELECT * FROM templates WHERE title = 'Őszi akció poszt'").get();
    assert.equal(template.original_name, 'őszi-akció.zip');

    const outsider = await register('kivulallo@example.com');
    assert.equal((await get(`/letoltes/${template.id}`, outsider)).headers.get('location'), '/elofizetes');
    assert.equal((await get(`/letoltes/${template.id}`)).headers.get('location'), '/belepes');
    assert.equal((await get('/admin', outsider)).status, 404);
    assert.equal((await post('/admin/sablon', { cookie: outsider, body: new FormData() })).status, 404);

    const { cookie } = await subscribe('gabi@example.com');
    const library = await (await get('/tagoknak?honap=2026-10&tipus=Poszt', cookie)).text();
    assert.match(library, /Őszi akció poszt/);
    const download = await get(`/letoltes/${template.id}`, cookie);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(await download.text(), 'zip-tartalom');
    assert.equal((await get(`/elonezet/${template.id}`, cookie)).headers.get('content-type'), 'image/png');

    await post(`/admin/sablon/${template.id}/torles`, { cookie: adminCookie });
    assert.equal((await get(`/letoltes/${template.id}`, cookie)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'files')), []);
  });

  test('link templates redirect members to the link; invalid uploads are refused', async () => {
    const adminCookie = await register('admin2@example.com');
    db.prepare('INSERT INTO templates (title, category, month, link_url) VALUES (?, ?, ?, ?)')
      .run('Canva Reel', 'Reel', '2026-09', 'https://www.canva.com/design/abc');
    const { id } = db.prepare("SELECT id FROM templates WHERE title = 'Canva Reel'").get();
    const { cookie } = await subscribe('hedi@example.com');
    const res = await get(`/letoltes/${id}`, cookie);
    assert.equal(res.headers.get('location'), 'https://www.canva.com/design/abc');

    const noContent = new FormData();
    noContent.set('title', 'Üres');
    noContent.set('category', 'Poszt');
    noContent.set('month', '2026-10');
    // admin2 is not in ADMIN_EMAILS, so this is a 404 rather than a validation error
    assert.equal((await post('/admin/sablon', { cookie: adminCookie, body: noContent })).status, 404);
    const realAdmin = sessionCookie(await post('/belepes', { form: { email: 'admin@example.com', password: 'jelszo1234' } }));
    const refused = await post('/admin/sablon', { cookie: realAdmin, body: noContent });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /Tölts fel egy fájlt/);
  });

  test('user-supplied text is HTML-escaped', async () => {
    db.prepare('INSERT INTO templates (title, category, month, link_url) VALUES (?, ?, ?, ?)')
      .run('<script>alert(1)</script>', 'Poszt', '2026-08', 'https://example.com/x');
    const { cookie } = await subscribe('ildi@example.com');
    const body = await (await get('/tagoknak', cookie)).text();
    assert.ok(!body.includes('<script>alert(1)</script>'));
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});
