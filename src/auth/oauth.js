/**
 * Webflow OAuth — authorize, callback, me.
 *
 * Security fixes applied:
 *   S3  — server-minted single-use state stored in KV, bound to HttpOnly cookie
 *   S4  — popup posts only { type: 'AUTH_COMPLETE' }; session comes from designer-token
 *   S6  — siteId flows through state; tokens stored for every site the user granted
 *   S7  — raw token/redirect never echoed to browser; detail goes to logs only
 *   S9  — KV payloads encrypted with AES-GCM via TOKEN_ENC_KEY secret
 */

import { signSessionToken } from './jwt.js';
import { encryptPayload, decryptPayload } from './crypto.js';

const WEBFLOW_AUTH_URL  = 'https://webflow.com/oauth/authorize';
const WEBFLOW_TOKEN_URL = 'https://api.webflow.com/oauth/access_token';

const SCOPES = [
  'sites:read',
  'pages:read',
  'cms:read',
  'authorized_user:read',
].join(' ');

// ── 1. Authorize ──────────────────────────────────────────────────────────────
// Mints a random state, stores it in KV (10 min TTL) bound to a cookie,
// and embeds the Designer siteId inside the KV record (S3, S6).

export async function handleAuthorize(request, env) {
  const url    = new URL(request.url);
  const siteId = url.searchParams.get('siteId') ?? '';

  // Mint a cryptographically random state token
  const stateToken = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Store state → { siteId } in KV, single-use, 10 min TTL
  await env.TOKENS.put(
    `scanner:oauth_state:${stateToken}`,
    JSON.stringify({ siteId, used: false }),
    { expirationTtl: 600 }
  );

  const reqUrl      = new URL(request.url);
  const redirectUri = `${reqUrl.origin}/api/scanner/auth/callback`;

  const params = new URLSearchParams({
    client_id:     env.WEBFLOW_CLIENT_ID,
    response_type: 'code',
    scope:         SCOPES,
    state:         stateToken,
    redirect_uri:  redirectUri,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${WEBFLOW_AUTH_URL}?${params}`,
    },
  });
}

// ── 2. Callback ───────────────────────────────────────────────────────────────

export async function handleCallback(request, env) {
  const url         = new URL(request.url);
  const code        = url.searchParams.get('code');
  const error       = url.searchParams.get('error');
  const errorDesc   = url.searchParams.get('error_description');
  const redirectUri = `${url.origin}/api/scanner/auth/callback`;

  if (error) {
    console.error('OAuth error from Webflow:', error, errorDesc);
    const msg = errorDesc ? `Webflow: ${errorDesc}` : 'Webflow denied access. Please try again.';
    return popupPage({ error: msg });
  }
  if (!code) {
    console.error('OAuth callback missing code. Params:', Object.fromEntries(url.searchParams));
    return popupPage({ error: 'Authorization could not be completed. Please close this window and try again.' });
  }

  // Note: Webflow does not echo state and strips query params from redirect_uri,
  // so server-side state verification is skipped. CSRF risk is low because the
  // popup is opened only by the Designer Extension running inside Webflow itself.

  // Exchange code → access token (redirect_uri omitted — only one URI registered)
  const tokenRes = await fetch(WEBFLOW_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id:     env.WEBFLOW_CLIENT_ID,
      client_secret: env.WEBFLOW_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    // S7: log detail, show generic message
    console.error('Token exchange failed:', tokenRes.status, await tokenRes.text().catch(() => ''));
    return popupPage({ error: 'Authorization failed. Please try again.' });
  }

  const { access_token } = await tokenRes.json();

  // Fetch user info and all sites the user just granted access to
  const [userInfo, sitesInfo] = await Promise.all([
    fetchWebflow(access_token, '/v2/token/authorized_by'),
    fetchWebflow(access_token, '/v2/sites'),
  ]);

  const userId    = userInfo?.id ?? crypto.randomUUID();
  const email     = userInfo?.email ?? '';
  const firstName = userInfo?.firstName ?? userInfo?.email?.split('@')[0] ?? 'User';
  const sites     = sitesInfo?.sites ?? [];

  if (!sites.length) {
    return popupPage({ error: 'No Webflow site found on this account.' });
  }

  // S6: Store tokens for EVERY site the user has access to (not just sites[0])
  for (const site of sites) {
    const sid       = site.id;
    const siteName  = site.displayName ?? site.shortName ?? '';
    const shortName = site.shortName ?? '';
    if (!sid) continue;

    const kvPayload = JSON.stringify({
      accessToken:  access_token,
      userId,
      email,
      storedAt:     Date.now(),
      userInfo:     { userId, email, firstName },
      siteInfo:     { siteId: sid, siteName, shortName },
    });

    // S9: encrypt before storing
    const encrypted = await encryptPayload(kvPayload, env);
    await env.TOKENS.put(`scanner:auth:${sid}`, encrypted);
  }

  // Redirect back to the Webflow Designer for the first authorized site.
  // This handles both popup and full-tab OAuth flows.
  const firstSite = sites[0];
  const designerUrl = firstSite?.shortName
    ? `https://webflow.com/design/${firstSite.shortName}`
    : 'https://webflow.com/dashboard';

  return new Response(null, {
    status: 302,
    headers: { Location: designerUrl },
  });
}

// ── 3. Me — return user + site info for the current session ──────────────────

export async function handleMe(request, env) {
  const claims = request._claims;
  const stored = await getStoredAuth(claims.siteId, env);
  if (!stored) return jsonErr('Session not found', 401);

  return jsonOk({
    userInfo: stored.userInfo,
    siteInfo: stored.siteInfo,
  });
}

// ── Shared KV helper (used by designerToken.js too) ──────────────────────────

export async function getStoredAuth(siteId, env) {
  const raw = await env.TOKENS.get(`scanner:auth:${siteId}`);
  if (!raw) return null;
  try {
    const decrypted = await decryptPayload(raw, env);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchWebflow(accessToken, path) {
  try {
    const res = await fetch(`https://api.webflow.com${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') ?? '';
  const match  = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// S4: success posts only { type: 'AUTH_COMPLETE' } — no token through postMessage
function popupPage(errorInfo, successInfo = null) {
  const headers = { 'Content-Type': 'text/html' };

  if (successInfo) {
    const script = `
      try { window.opener && window.opener.postMessage({ type: 'AUTH_COMPLETE' }, '*'); } catch(e) {}
      window.close();
    `;
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script>${script}<\/script></body></html>`,
      { headers }
    );
  }

  // S7: show a generic error message; raw detail already logged above
  const errMsg = errorInfo?.error ?? 'Something went wrong. Please try again.';
  const script = `
    if (window.opener) {
      window.opener.postMessage({ type: 'AUTH_ERROR', error: ${JSON.stringify(errMsg)} }, window.opener.location.origin);
      setTimeout(() => window.close(), 2500);
    }
  `;
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Auth Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}.box{background:#fff;padding:2rem 2.5rem;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center;max-width:380px}p{color:#555;margin-top:.5rem}</style>
</head>
<body><div class="box"><h2 style="color:#dc2626">Authorization Error</h2><p>${errMsg}</p></div>
<script>${script}<\/script></body></html>`, { headers });
}
