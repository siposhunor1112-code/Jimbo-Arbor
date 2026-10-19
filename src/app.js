import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import {
  SESSION_COOKIE, createLoginLimiter, createSessionStore, hasAccess, hashPassword, isAdmin,
  sessionCookieOptions, verifyPassword,
} from './auth.js';
import { createBilling } from './billing.js';
import { createLibrary } from './library.js';
import * as views from './views.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const PREVIEW_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  // Our POST handlers redirect to Stripe; browsers apply form-action to that redirect.
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
].join('; ');

const send = (res, page, status = 200) => res.status(status).type('html').send(page.toString());

export function createApp({ config, db, stripe, log = console }) {
  const app = express();
  const sessions = createSessionStore(db);
  const loginLimiter = createLoginLimiter();
  const library = createLibrary(db, path.join(config.dataDir, 'files'));
  const billing = createBilling({ db, stripe, config, log });
  const expectedOrigin = new URL(config.baseUrl).origin;

  const insertUser = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');

  const uploadDir = path.join(config.dataDir, 'uploads-tmp');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    dest: uploadDir,
    defParamCharset: 'utf8', // keep accented file names (őszi-akció.zip) intact
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 20 },
  }).fields([{ name: 'file', maxCount: 1 }, { name: 'preview', maxCount: 1 }]);

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  // Stripe signs the exact bytes it sent, so this route must see the raw body.
  app.post('/webhook/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = billing.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      log.warn(`Stripe webhook rejected: ${err.message}`);
      return res.status(400).send('invalid signature');
    }
    try {
      await billing.handleEvent(event);
    } catch (err) {
      // A 500 makes Stripe retry later; handling is idempotent.
      log.error(`Stripe webhook ${event.type} (${event.id}) failed`, err);
      return res.status(500).send('error');
    }
    res.json({ received: true });
  });

  app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h' }));
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));

  // CSRF defence: state-changing requests must come from our own pages.
  // Combined with SameSite=Lax cookies; the Stripe webhook above is exempt.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin') ?? (req.get('referer') ? safeOrigin(req.get('referer')) : null);
    if (origin !== expectedOrigin) return res.status(403).send('Érvénytelen kérés.');
    next();
  });

  app.use((req, res, next) => {
    const user = sessions.userFor(req.cookies[SESSION_COOKIE]);
    res.locals.ctx = { config, user, member: hasAccess(user, config), admin: isAdmin(user, config) };
    next();
  });

  const requireLogin = (req, res, next) => (res.locals.ctx.user ? next() : res.redirect(303, '/belepes'));
  const requireMember = (req, res, next) => {
    const { user, member } = res.locals.ctx;
    if (!user) return res.redirect(303, '/belepes');
    if (!member) return res.redirect(303, '/elofizetes');
    next();
  };
  const requireAdmin = (req, res, next) => (res.locals.ctx.admin ? next() : notFound(req, res));

  function signIn(res, userId) {
    res.cookie(SESSION_COOKIE, sessions.start(userId), sessionCookieOptions(config));
  }

  // ---- Public pages -------------------------------------------------------

  app.get('/', (req, res) => send(res, views.landingPage(res.locals.ctx)));

  app.get('/regisztracio', (req, res) => {
    if (res.locals.ctx.user) return res.redirect(303, '/elofizetes');
    send(res, views.authPage(res.locals.ctx, { mode: 'register' }));
  });

  app.post('/regisztracio', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    const fail = (error) => send(res, views.authPage(res.locals.ctx, { mode: 'register', email, error }), 400);

    if (!EMAIL_PATTERN.test(email) || email.length > 254) return fail('Adj meg egy érvényes e-mail-címet.');
    if (password.length < 8 || password.length > 200) return fail('A jelszó legalább 8 karakter legyen.');
    if (userByEmail.get(email)) return fail('Ezzel az e-mail-címmel már van fiók. Lépj be.');

    const { lastInsertRowid } = insertUser.run(email, await hashPassword(password));
    signIn(res, lastInsertRowid);
    res.redirect(303, '/elofizetes');
  });

  app.get('/belepes', (req, res) => {
    if (res.locals.ctx.user) return res.redirect(303, '/tagoknak');
    send(res, views.authPage(res.locals.ctx, { mode: 'login' }));
  });

  app.post('/belepes', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    const limitKey = `${req.ip}|${email}`;
    const fail = (error, status = 400) => send(res, views.authPage(res.locals.ctx, { mode: 'login', email, error }), status);

    if (loginLimiter.isBlocked(limitKey)) return fail('Túl sok sikertelen próbálkozás. Próbáld újra 15 perc múlva.', 429);
    const user = userByEmail.get(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      loginLimiter.recordFailure(limitKey);
      return fail('Hibás e-mail-cím vagy jelszó.');
    }
    loginLimiter.reset(limitKey);
    signIn(res, user.id);
    res.redirect(303, hasAccess(user, config) ? '/tagoknak' : '/elofizetes');
  });

  app.post('/kilepes', (req, res) => {
    sessions.end(req.cookies[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(config), maxAge: undefined });
    res.redirect(303, '/');
  });

  // ---- Subscription -------------------------------------------------------

  app.get('/elofizetes', requireLogin, (req, res) => {
    if (res.locals.ctx.member) return res.redirect(303, '/tagoknak');
    send(res, views.subscribePage(res.locals.ctx));
  });

  app.post('/elofizetes/fizetes', requireLogin, async (req, res) => {
    const { user, member } = res.locals.ctx;
    if (member) return res.redirect(303, '/tagoknak');
    try {
      res.redirect(303, await billing.startCheckout(user));
    } catch (err) {
      log.error('Stripe checkout failed', err);
      send(res, views.subscribePage(res.locals.ctx, { error: 'A fizetési oldal most nem érhető el. Próbáld újra pár perc múlva.' }), 502);
    }
  });

  app.get('/elofizetes/sikeres', requireLogin, async (req, res) => {
    const sessionId = String(req.query.session_id ?? '');
    if (sessionId) {
      try {
        await billing.confirmCheckout(res.locals.ctx.user, sessionId);
      } catch (err) {
        // The webhook will still deliver the subscription; the member page explains the wait.
        log.error('Stripe checkout confirmation failed', err);
      }
    }
    res.redirect(303, '/tagoknak?udv=1');
  });

  app.get('/fiok', requireLogin, (req, res) => send(res, views.accountPage(res.locals.ctx)));

  app.post('/fiok/szamlazas', requireLogin, async (req, res) => {
    const { user } = res.locals.ctx;
    if (!user.stripe_customer_id) return res.redirect(303, '/elofizetes');
    try {
      res.redirect(303, await billing.portalUrl(user));
    } catch (err) {
      log.error('Stripe billing portal failed', err);
      send(res, views.accountPage(res.locals.ctx, { error: 'Az előfizetés-kezelő most nem érhető el. Próbáld újra pár perc múlva.' }), 502);
    }
  });

  // ---- Member area --------------------------------------------------------

  app.get('/tagoknak', (req, res, next) => {
    // Right after checkout the webhook may lag a few seconds behind the redirect.
    const { user, member } = res.locals.ctx;
    if (user && !member && req.query.udv) {
      return send(res, views.messagePage(res.locals.ctx, {
        title: 'Köszönjük az előfizetést!',
        message: 'A fizetés feldolgozása folyamatban van. Frissítsd az oldalt néhány másodperc múlva.',
      }));
    }
    next();
  }, requireMember, (req, res) => {
    const month = MONTH_PATTERN.test(req.query.honap ?? '') ? req.query.honap : null;
    const category = typeof req.query.tipus === 'string' && req.query.tipus ? req.query.tipus.slice(0, 40) : null;
    send(res, views.libraryPage(res.locals.ctx, {
      templates: library.list({ month, category }),
      months: library.months(),
      categories: library.categories(),
      month,
      category,
      notice: req.query.udv ? 'Üdv a tagok között! Jó posztolást!' : null,
    }));
  });

  const templateParam = (req) => library.get(Number.parseInt(req.params.id, 10));

  // A template row whose file went missing on disk is a 404, not a crash.
  const fileSent = (req, res, next) => (err) => {
    if (!err) return;
    if (res.headersSent) return log.error(`Sending ${req.path} was interrupted`, err);
    if (err.code === 'ENOENT') {
      log.error(`File missing on disk for ${req.path}`);
      return notFound(req, res);
    }
    next(err);
  };

  app.get('/letoltes/:id', requireMember, (req, res, next) => {
    const template = templateParam(req);
    if (!template) return notFound(req, res);
    if (template.link_url) return res.redirect(302, template.link_url);
    res.set('Cache-Control', 'private, no-store');
    // Always a download, never rendered by the browser, whatever was uploaded.
    res.download(library.filePath(template.file_key), template.original_name, {
      headers: { 'Content-Type': 'application/octet-stream' },
    }, fileSent(req, res, next));
  });

  app.get('/elonezet/:id', requireMember, (req, res, next) => {
    const template = templateParam(req);
    if (!template?.preview_key) return notFound(req, res);
    res.set({ 'Content-Type': template.preview_mime, 'Cache-Control': 'private, max-age=3600' });
    res.sendFile(library.filePath(template.preview_key), fileSent(req, res, next));
  });

  // ---- Admin --------------------------------------------------------------

  const adminView = (res, extra = {}) =>
    views.adminPage(res.locals.ctx, { templates: library.list(), categories: library.categories(), ...extra });

  app.get('/admin', requireAdmin, (req, res) => {
    send(res, adminView(res, { notice: req.query.ok ? 'Mentve.' : null }));
  });

  app.post('/admin/sablon', requireAdmin, (req, res, next) => {
    upload(req, res, (err) => {
      if (!err) return next();
      const error = err.code === 'LIMIT_FILE_SIZE' ? 'A fájl túl nagy (legfeljebb 200 MB).' : 'A feltöltés nem sikerült.';
      send(res, adminView(res, { error }), 400);
    });
  }, (req, res) => {
    const file = req.files?.file?.[0];
    const preview = req.files?.preview?.[0];
    const cleanup = () => [file, preview].forEach((f) => f && fs.rmSync(f.path, { force: true }));
    const values = {
      title: String(req.body.title ?? '').trim(),
      category: String(req.body.category ?? '').trim(),
      month: String(req.body.month ?? '').trim(),
      description: String(req.body.description ?? '').trim(),
      linkUrl: String(req.body.linkUrl ?? '').trim(),
    };

    const error = validateTemplate(values, file, preview);
    if (error) {
      cleanup();
      return send(res, adminView(res, { values, error }), 400);
    }

    const storedKeys = [];
    const keep = (f) => {
      if (!f) return null;
      const key = crypto.randomBytes(16).toString('hex');
      fs.renameSync(f.path, library.filePath(key));
      storedKeys.push(key);
      return key;
    };
    try {
      const fileKey = keep(file);
      const previewKey = keep(preview);
      library.add({
        title: values.title,
        description: values.description,
        category: values.category,
        month: values.month,
        fileKey,
        originalName: file ? file.originalname : null,
        sizeBytes: file ? file.size : null,
        linkUrl: file ? null : values.linkUrl,
        previewKey,
        previewMime: preview ? preview.mimetype : null,
      });
    } catch (err) {
      // Leave nothing behind: neither half-moved files nor temp uploads.
      log.error('Saving uploaded template failed', err);
      storedKeys.forEach((key) => library.deleteFile(key));
      cleanup();
      return send(res, adminView(res, { values, error: 'A sablont nem sikerült elmenteni. Próbáld újra.' }), 500);
    }
    res.redirect(303, '/admin?ok=1');
  });

  app.post('/admin/sablon/:id/torles', requireAdmin, (req, res) => {
    library.remove(Number.parseInt(req.params.id, 10));
    res.redirect(303, '/admin?ok=1');
  });

  // ---- Fallbacks ----------------------------------------------------------

  function notFound(req, res) {
    send(res, views.messagePage(res.locals.ctx ?? { config }, { title: 'Nincs ilyen oldal', message: 'A keresett oldal nem található.' }), 404);
  }
  app.use(notFound);

  app.use((err, req, res, next) => {
    log.error(`${req.method} ${req.path} failed`, err);
    if (res.headersSent) return next(err);
    send(res, views.messagePage(res.locals.ctx ?? { config }, { title: 'Hiba történt', message: 'Valami elromlott. Próbáld újra később.' }), 500);
  });

  return app;
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function validateTemplate(values, file, preview) {
  if (!values.title || values.title.length > 200) return 'Adj meg egy címet (legfeljebb 200 karakter).';
  if (!values.category || values.category.length > 40) return 'Adj meg egy típust (például Poszt vagy Reel).';
  if (!MONTH_PATTERN.test(values.month)) return 'Válassz hónapot.';
  if (values.description.length > 1000) return 'A leírás legfeljebb 1000 karakter lehet.';
  if (file && values.linkUrl) return 'Fájlt vagy linket adj meg, a kettőt egyszerre ne.';
  if (!file && !values.linkUrl) return 'Tölts fel egy fájlt, vagy adj meg egy linket.';
  if (values.linkUrl && !/^https:\/\/\S+$/.test(values.linkUrl)) return 'A link https://-sel kezdődjön.';
  if (preview && !PREVIEW_MIMES.has(preview.mimetype)) return 'Az előnézet JPG, PNG vagy WebP kép legyen.';
  return null;
}
