import fs from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(path.join(config.dataDir, 'app.db'));
const stripe = new Stripe(config.stripe.secretKey);

const server = createApp({ config, db, stripe }).listen(config.port, () => {
  console.log(`${config.siteName} fut: http://localhost:${config.port} (nyilvános cím: ${config.baseUrl})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
