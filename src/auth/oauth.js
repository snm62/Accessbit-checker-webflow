

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



export async function handleAuthorize(request, env) {
  const url    = new URL(request.url);
  const siteId = url.searchParams.get('siteId') ?? '';

 
  const stateToken = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

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
   
    console.error('Token exchange failed:', tokenRes.status, await tokenRes.text().catch(() => ''));
    return popupPage({ error: 'Authorization failed. Please try again.' });
  }

  const { access_token } = await tokenRes.json();


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

    const encrypted = await encryptPayload(kvPayload, env);
    await env.TOKENS.put(`scanner:auth:${sid}`, encrypted);
  }


  const firstSite = sites[0];
  const workerOrigin = new URL(request.url).origin;
  return popupPage(null, { siteId: firstSite?.id ?? '', shortName: firstSite?.shortName ?? '', clientId: env.WEBFLOW_CLIENT_ID ?? '', workerOrigin });
}



export async function handleMe(request, env) {
  const claims = request._claims;
  const stored = await getStoredAuth(claims.siteId, env);
  if (!stored) return jsonErr('Session not found', 401);

  return jsonOk({
    userInfo: stored.userInfo,
    siteInfo: stored.siteInfo,
  });
}



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

function popupPage(errorInfo, successInfo = null) {
  const headers = { 'Content-Type': 'text/html' };

  if (successInfo) {
    const { shortName, clientId, workerOrigin } = successInfo;

    const designerUrl = shortName && clientId
      ? `https://${shortName}.design.webflow.com?app=${clientId}`
      : shortName
        ? `https://webflow.com/design/${shortName}`
        : 'https://webflow.com/dashboard';
    const script = `
(function(){
  var payload = ${JSON.stringify({ type: 'AUTH_COMPLETE' })};
  var origin = ${JSON.stringify(workerOrigin)};
  function send(){
    try{ if(window.opener&&!window.opener.closed) window.opener.postMessage(payload,origin); }catch(e){}
    try{ if(window.parent&&window.parent!==window) window.parent.postMessage(payload,origin); }catch(e){}
  }
  send();
  setTimeout(send,100);
  setTimeout(send,500);
  // Redirect instead of window.close() — Designer context blocks close().
  // 2000ms gives the opener time to receive AUTH_COMPLETE and call attemptAuth().
  setTimeout(function(){ window.location.replace(${JSON.stringify(designerUrl)}); },2000);
})();
    `;
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Authorizing...</title><script>${script}<\/script>`,
      { headers }
    );
  }

 
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
