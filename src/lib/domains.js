import { getStoredAuth } from '../auth/oauth.js';

export async function getAllowedDomains(siteId, accessToken, env) {
  const cacheKey = `scanner:domaincache:${siteId}`;

  const cached = await env.TOKENS.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  const stored = await getStoredAuth(siteId, env);
  const shortName = stored?.siteInfo?.shortName ?? '';

  const domainsRes = await fetch(`https://api.webflow.com/v2/sites/${siteId}/custom_domains`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => null);

  let customDomains = [];
  if (domainsRes?.ok) {
    const data = await domainsRes.json().catch(() => ({}));
    customDomains = (data.customDomains ?? data.domains ?? [])
      .flatMap(d => {
        const raw = (d.url ?? d.hostname ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
        if (!raw) return [];
        const apex = raw.startsWith('www.') ? raw.slice(4) : raw;
        const www  = raw.startsWith('www.') ? raw : `www.${raw}`;
        return [apex, www];
      })
      .filter(Boolean);
  } else if (domainsRes?.status === 403) {
    // Keep existing cache — do NOT shrink the allowlist on a 403
    console.warn(`[domains] 403 from Webflow domains API for site ${siteId} — keeping cached allowlist`);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }
  }

  const allowlist = [
    ...(shortName ? [`${shortName}.webflow.io`] : []),
    ...new Set(customDomains),
  ];

  await env.TOKENS.put(cacheKey, JSON.stringify(allowlist), { expirationTtl: 3600 });
  return allowlist;
}

export async function validateDomainOwnership(pageUrl, siteId, accessToken, env) {
  let hostname;
  try {
    hostname = new URL(pageUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    throw Object.assign(new Error('Invalid URL'), { status: 400 });
  }

  const allowlist = await getAllowedDomains(siteId, accessToken, env);
  if (allowlist.includes(hostname)) return;

  const peer = hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`;
  if (allowlist.includes(peer)) return;

  throw Object.assign(
    new Error(
      `${hostname} does not belong to your connected Webflow site. ` +
      `Allowed: ${allowlist.join(', ') || '(none yet)'}`
    ),
    { status: 403 }
  );
}
