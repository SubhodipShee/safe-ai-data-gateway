// =============================================================================
// security.js: protections for running the gateway on the public internet (Phase 10)
// =============================================================================
//
// On your laptop (HOST=127.0.0.1) only you can reach the gateway. Online, ANYONE
// can, so four things are added here:
//
//   1. SECURITY HEADERS (helmet)   tell the browser to block common web attacks
//   2. HTTPS ONLY                  plain http:// visits are sent to https://
//   3. RATE LIMITS                 one visitor can't flood the gateway, fill up
//                                  the free database, or use up the free AI quota
//   4. ADMIN KEY                   only you can change the policies
//
// What is deliberately NOT added: CORS. Without CORS headers, the browser stops
// other websites from calling the gateway with JSON. The extension is allowed
// anyway (its manifest lists the gateway's address), and the playground and
// dashboard are served by the gateway itself, so they never need CORS.
// =============================================================================

import { createHash, timingSafeEqual } from 'node:crypto';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

// -----------------------------------------------------------------------------
// 1. Security headers
// -----------------------------------------------------------------------------
/**
 * helmet adds headers such as Content-Security-Policy ("only run scripts that come
 * from this site"), X-Content-Type-Options and Strict-Transport-Security.
 * @param {boolean} isPublic  true when hosted online (HTTPS available)
 */
export function securityHeaders(isPublic) {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        // "upgrade-insecure-requests" makes the browser load everything over https.
        // Right online; wrong on http://127.0.0.1 (there is no https there), so only online.
        upgradeInsecureRequests: isPublic ? [] : null,
      },
    },
    // Strict-Transport-Security ("always use https for this site") only makes sense online.
    strictTransportSecurity: isPublic,
  });
}

// -----------------------------------------------------------------------------
// 2. HTTPS only
// -----------------------------------------------------------------------------
/**
 * Render (and Cloudflare) handle the HTTPS certificate and pass the request on,
 * telling us the original protocol in the X-Forwarded-Proto header. If a visitor
 * came in over plain http, send them to the https address instead.
 */
export function redirectToHttps(req, res, next) {
  if (req.get('x-forwarded-proto') === 'http') {
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  }
  next();
}

// -----------------------------------------------------------------------------
// 3. Rate limits (counted per visitor IP address, kept in memory)
// -----------------------------------------------------------------------------
/** Builds one limiter. `limit` requests are allowed per `minutes`. */
function limiter({ limit, minutes, what, perVisitor = true }) {
  return rateLimit({
    windowMs: minutes * 60_000,
    limit,
    standardHeaders: 'draft-8', // tells well-behaved clients how long to wait (RateLimit header)
    legacyHeaders: false,
    // perVisitor=false → ONE shared counter for everybody (protects a total quota).
    ...(perVisitor ? {} : { keyGenerator: () => 'everyone' }),
    message: { error: `Too many ${what}. Please wait a little and try again.` },
  });
}

/**
 * The limits, sized for a demo:
 *   - masking: 30 per minute is far more than anyone types into a chat
 *   - unmask: higher, because the extension restores tags every time the page changes
 *   - real AI: low per visitor, AND a daily total so the free Groq quota can't be used up
 *   - admin: few attempts, so nobody can guess the admin key
 */
export function createRateLimits() {
  return {
    mask: limiter({ limit: 30, minutes: 1, what: 'requests to mask text' }),
    unmask: limiter({ limit: 300, minutes: 1, what: 'restore requests' }),
    read: limiter({ limit: 60, minutes: 1, what: 'requests' }),
    aiPerVisitor: limiter({ limit: 6, minutes: 1, what: 'AI requests' }),
    aiTotalPerDay: limiter({ limit: 300, minutes: 24 * 60, what: 'AI requests today (demo limit)', perVisitor: false }),
    admin: limiter({ limit: 20, minutes: 15, what: 'admin attempts' }),
  };
}

// -----------------------------------------------------------------------------
// 4. Admin key
// -----------------------------------------------------------------------------
/** SHA-256 of a string: both sides get the same length, which timingSafeEqual needs. */
const sha256 = (text) => createHash('sha256').update(String(text)).digest();

/**
 * Only lets the request through with the header "Authorization: Bearer <ADMIN_KEY>".
 * Without an ADMIN_KEY (your laptop), everything is allowed, as before.
 *
 * timingSafeEqual compares in constant time, so an attacker can't work out the key
 * character by character from how fast a wrong guess is rejected.
 * @param {string|undefined} adminKey
 */
export function requireAdminKey(adminKey) {
  return (req, res, next) => {
    if (!adminKey) return next();
    const sent = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (sent && timingSafeEqual(sha256(sent), sha256(adminKey))) return next();
    res.status(401).json({ error: 'Admin key required to change policies.' });
  };
}
