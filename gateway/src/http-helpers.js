// =============================================================================
// http-helpers.js: small helpers shared by the routes
// =============================================================================

import { dbStatus } from './db.js';
import { isValidSessionId } from './vault.js';

/** Sends a "400 Bad Request" with a clear message. */
export function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/**
 * Checks the fields every vault request needs.
 * Returns an error message, or null if everything is fine.
 */
export function checkSessionAndText(body) {
  if (!isValidSessionId(body?.sessionId)) {
    return 'sessionId must be 16–64 letters, digits, "_" or "-" (a UUID works)';
  }
  if (typeof body.text !== 'string') {
    return 'text must be a string';
  }
  return null;
}

/**
 * Middleware: stops the request early with "503" if the database isn't connected,
 * instead of letting it hang while Mongoose waits for the connection.
 */
export function requireDatabase(req, res, next) {
  if (dbStatus() !== 'connected') {
    return res.status(503).json({ error: 'Database unavailable. Try again in a few seconds.' });
  }
  next();
}

/**
 * The LAST middleware: catches any error from the routes and sends a safe response.
 * We never send error details to the client (they could reveal internals),
 * and we never log request bodies (they contain sensitive text).
 */
// Express recognises an error handler by its 4 parameters, so `next` must stay even though it's unused.
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  // Body wasn't valid JSON.
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Body is not valid JSON' });
  }
  // Body bigger than the 1 MB limit, or text longer than detect() accepts.
  if (error.type === 'entity.too.large' || error instanceof RangeError) {
    return res.status(413).json({ error: 'Text is too long' });
  }

  console.error(`[error] ${req.method} ${req.path}: ${error.message}`);
  res.status(500).json({ error: 'Something went wrong on the gateway' });
}
