/**
 * Minimal JWT (HS256) using the Web Crypto API.
 * No external dependencies — runs natively in Cloudflare Workers.
 *
 * Token payload:
 *   { sub: userId, siteId, jti: uuid, iat, exp }
 *
 * Add WORKER_JWT_SECRET as a Worker secret:
 *   wrangler secret put WORKER_JWT_SECRET
 */

const SESSION_TTL_SECONDS = 3600; // 1 hour
const REFRESH_BEFORE_EXPIRY = 60;  // auto-refresh 60s before expiry

// ── Sign ──────────────────────────────────────────────────────────────────────

export async function signSessionToken(env, { userId, siteId }) {
  const now  = Math.floor(Date.now() / 1000);
  const jti  = crypto.randomUUID();

  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: userId,
    siteId,
    jti,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }));

  const signing    = `${header}.${payload}`;
  const key        = await importKey(env.WORKER_JWT_SECRET);
  const sig        = await crypto.subtle.sign('HMAC', key, enc(signing));
  const sigB64     = b64urlFromBuffer(sig);

  return `${signing}.${sigB64}`;
}

// ── Verify ────────────────────────────────────────────────────────────────────

export async function verifySessionToken(env, token) {
  if (!token || typeof token !== 'string') throw new Error('Missing token');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');

  const [header, payload, sig] = parts;
  const signing = `${header}.${payload}`;

  const key   = await importKey(env.WORKER_JWT_SECRET);
  const valid = await crypto.subtle.verify('HMAC', key, b64urlToBuffer(sig), enc(signing));
  if (!valid) throw new Error('Invalid token signature');

  const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  const now    = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new Error('Token expired');

  return claims;
}

// Returns seconds until token needs refresh (negative = already expired)
export function secondsUntilRefresh(token) {
  try {
    const payload = token.split('.')[1];
    const { exp } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return exp - REFRESH_BEFORE_EXPIRY - Math.floor(Date.now() / 1000);
  } catch {
    return -1;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function importKey(secret) {
  if (!secret) throw new Error('WORKER_JWT_SECRET is not set');
  return crypto.subtle.importKey(
    'raw',
    enc(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function enc(str) {
  return new TextEncoder().encode(str);
}

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlFromBuffer(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlToBuffer(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin    = atob(base64);
  const buf    = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
