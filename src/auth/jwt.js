

const SESSION_TTL_SECONDS = 3600; 
const REFRESH_BEFORE_EXPIRY = 60;  



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

  if (claims.jti && env.TOKENS) {
    const revoked = await env.TOKENS.get(`scanner:jti:revoked:${claims.jti}`);
    if (revoked) throw new Error('Token has been revoked');
  }

  return claims;
}

export async function revokeToken(token, env) {
  try {
    const parts = token?.split('.');
    if (!parts || parts.length !== 3) return;
    const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!claims.jti || !claims.exp) return;
    const ttl = Math.max(1, claims.exp - Math.floor(Date.now() / 1000));
    await env.TOKENS.put(`scanner:jti:revoked:${claims.jti}`, '1', { expirationTtl: ttl });
  } catch { /* ignore malformed tokens */ }
}


export function secondsUntilRefresh(token) {
  try {
    const payload = token.split('.')[1];
    const { exp } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return exp - REFRESH_BEFORE_EXPIRY - Math.floor(Date.now() / 1000);
  } catch {
    return -1;
  }
}



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
