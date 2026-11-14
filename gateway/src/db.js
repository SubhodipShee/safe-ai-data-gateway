// =============================================================================
// db.js: connects to MongoDB Atlas (using Mongoose)
// =============================================================================
//
// Functions in this file:
//   connectDb(uri)     open the connection (called once when the server starts)
//   dbStatus()         'connected' / 'connecting' / 'disconnected' (shown at /health)
//   disconnectDb()     close the connection (when the server stops)
//   explainDbError()   turns confusing Atlas errors into a plain fix
// =============================================================================

import dns from 'node:dns';
import mongoose from 'mongoose';

/** The database name inside Atlas. Used even if the connection string doesn't name one. */
export const DB_NAME = 'safe-ai-gateway';

// Mongoose reports its state as a number (0–3). This turns it into a word.
const STATE_NAMES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/**
 * Makes Node use specific DNS servers, e.g. ['8.8.8.8', '1.1.1.1'].
 * Needed on machines where the normal DNS refuses "mongodb+srv" lookups.
 */
export function useDnsServers(servers) {
  if (servers && servers.length > 0) {
    dns.setServers(servers);
    console.log(`[db] using DNS servers: ${servers.join(', ')}`);
  }
}

/**
 * Connects to MongoDB Atlas.
 * @param {string} uri  the connection string from .env
 * @param {object} [options]
 * @param {string[]} [options.dnsServers]  optional DNS servers (see useDnsServers)
 */
export async function connectDb(uri, options = {}) {
  useDnsServers(options.dnsServers);

  // Only allow queries on fields that exist in our schemas (safer).
  mongoose.set('strictQuery', true);

  // Log when the connection drops or comes back (e.g. Wi-Fi goes down).
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected from Atlas'));
  mongoose.connection.on('reconnected', () => console.log('[db] reconnected to Atlas'));

  await mongoose.connect(uri, {
    dbName: DB_NAME,
    // Give up after 10 seconds instead of waiting forever, e.g. when our IP
    // isn't allowed in Atlas or the password is wrong.
    serverSelectionTimeoutMS: 10_000,
  });

  const { host, name } = mongoose.connection;
  console.log(`[db] connected to Atlas (host: ${host}, database: ${name})`);
}

/** Returns the current connection state as a word, e.g. 'connected'. */
export function dbStatus() {
  const stateNumber = mongoose.connection.readyState;
  return STATE_NAMES[stateNumber] ?? 'unknown';
}

/** Closes the database connection. */
export async function disconnectDb() {
  await mongoose.disconnect();
}

/**
 * Turns common Atlas error messages into a plain-English fix.
 * The original error is often confusing, e.g. "querySrv ECONNREFUSED _mongodb._tcp…".
 */
export function explainDbError(error) {
  const message = String(error?.message || error);

  if (/bad auth|authentication failed/i.test(message)) {
    return 'Wrong username or password in MONGODB_URI. Reset the password in Atlas → Security → Database Access.';
  }
  if (/querySrv|ENOTFOUND|ECONNREFUSED.*_mongodb/i.test(message)) {
    return 'DNS lookup for mongodb+srv failed. Add DNS_SERVERS=8.8.8.8,1.1.1.1 to gateway/.env.';
  }
  if (/Server selection timed out|whitelist|IP.*not.*allowed|ETIMEDOUT/i.test(message)) {
    return 'Atlas did not respond. Your IP is probably not allowed: Atlas → Security → Network Access → Add Current IP Address.';
  }
  return message;
}
