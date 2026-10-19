import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

// Stripe keeps a canceled subscription "active" until the paid period ends,
// so these two statuses are exactly "has paid for right now".
const PAID_STATUSES = new Set(['active', 'trialing']);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(actual, expected);
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function isAdmin(user, config) {
  return Boolean(user) && config.adminEmails.includes(user.email.toLowerCase());
}

export function hasAccess(user, config) {
  return isAdmin(user, config) || PAID_STATUSES.has(user?.subscription_status);
}

export function createSessionStore(db) {
  const insert = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
  const findUser = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const purgeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    start(userId) {
      purgeExpired.run(Date.now());
      const token = crypto.randomBytes(32).toString('base64url');
      insert.run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
      return token;
    },
    userFor(token) {
      return token ? findUser.get(hashToken(token), Date.now()) ?? null : null;
    },
    end(token) {
      if (token) remove.run(hashToken(token));
    },
  };
}

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

// Small in-memory limiter against password guessing; enough for a single-process v1.
export function createLoginLimiter({ maxFailures = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const live = (key) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= Date.now()) failures.delete(key);
    return failures.get(key);
  };
  return {
    isBlocked: (key) => (live(key)?.count ?? 0) >= maxFailures,
    recordFailure(key) {
      if (failures.size > 10_000) {
        for (const [k, e] of failures) if (e.resetAt <= Date.now()) failures.delete(k);
      }
      const entry = live(key) ?? { count: 0, resetAt: Date.now() + windowMs };
      entry.count += 1;
      failures.set(key, entry);
    },
    reset: (key) => failures.delete(key),
  };
}
