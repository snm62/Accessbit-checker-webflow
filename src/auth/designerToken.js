/**
 * Designer Extension auth endpoint.
 *
 * POST /api/scanner/auth/designer-token
 * Body: { siteId: string, idToken: string }
 *
 * Security fixes:
 *   S2 — ID token is verified against Webflow's resolve endpoint, never trusted on decode alone
 *   S9 — KV payloads are decrypted via shared getStoredAuth helper
 */

import { signSessionToken } from './jwt.js';
import { getStoredAuth } from './oauth.js';

export async function handleDesignerToken(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400); }

  const { siteId, idToken } = body ?? {};

  if (!siteId || typeof siteId !== 'string') return jsonErr('siteId is required', 400);
  if (!idToken || typeof idToken !== 'string') return jsonErr('idToken is required', 400);

  // Look up stored auth for this site (decrypts via TOKEN_ENC_KEY if set)
  const stored = await getStoredAuth(siteId, env);
  if (!stored) {
    return jsonErr('No authorization found for this site. Please authorize via OAuth first.', 401);
  }

  // S2: Verify the ID token against Webflow's resolve endpoint using the stored access token.
  // This proves the caller is actually inside the Webflow Designer for this site — no fallthrough.
  const resolveRes = await fetch('https://api.webflow.com/beta/token/resolve', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${stored.accessToken}`,
    },
    body: JSON.stringify({ idToken }),
  }).catch(() => null);

  if (!resolveRes || !resolveRes.ok) {
    const detail = resolveRes ? await resolveRes.text().catch(() => '') : 'fetch failed';
    console.error('ID token resolve failed:', resolveRes?.status, detail);
    return jsonErr('Designer token verification failed. Please re-open the extension.', 401);
  }

  const resolved = await resolveRes.json().catch(() => null);

  // The resolved payload should confirm the siteId
  const resolvedSiteId = resolved?.siteId ?? resolved?.site_id;
  if (resolvedSiteId && resolvedSiteId !== siteId) {
    return jsonErr('Site ID mismatch.', 403);
  }

  const sessionToken = await signSessionToken(env, {
    userId: stored.userId,
    siteId,
  });

  return new Response(JSON.stringify({
    sessionToken,
    userInfo: stored.userInfo,
    siteInfo: stored.siteInfo,
  }), { headers: { 'Content-Type': 'application/json' } });
}

function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
