import path from 'node:path';

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Hiányzó környezeti változó: ${name} (lásd .env.example)`);
  return value;
}

export function loadConfig(env = process.env) {
  const baseUrl = required(env, 'BASE_URL').replace(/\/+$/, '');
  return {
    port: Number(env.PORT || 3000),
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    trustProxy: env.TRUST_PROXY === '1',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    siteName: env.SITE_NAME || 'Sablontár',
    audience: env.AUDIENCE || 'szépségipari szakembereknek',
    priceLabel: env.PRICE_LABEL || '4 990 Ft / hó',
    adminEmails: (env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    stripe: {
      secretKey: required(env, 'STRIPE_SECRET_KEY'),
      priceId: required(env, 'STRIPE_PRICE_ID'),
      webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    },
  };
}
