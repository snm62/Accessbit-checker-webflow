/**
 * listSitePages — fetch all scannable pages for a site from the Webflow Data API.
 * Shared by worker.js (pages endpoint) and routes/jobs.js (job creation).
 */

import { getAllowedDomains } from './domains.js';

export async function listSitePages(siteId, accessToken, env, selectedDomain = null) {
  const pages = [];
  let offset  = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(
      `https://api.webflow.com/v2/sites/${siteId}/pages?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(
        new Error(`Webflow pages API error ${res.status}: ${text.slice(0, 200)}`),
        { status: res.status === 401 ? 401 : 502 }
      );
    }
    const data  = await res.json();
    const batch = data.pages ?? [];
    pages.push(...batch);
    const { total, limit: lim, offset: off } = data.pagination ?? {};
    if (!total || pages.length >= total || batch.length < lim) break;
    offset = (off ?? offset) + lim;
  }

  const allowlist     = await getAllowedDomains(siteId, accessToken, env);
  const customDomain  = allowlist.find(d => !d.endsWith('.webflow.io'));
  const stagingDomain = allowlist.find(d => d.endsWith('.webflow.io'));
  const defaultDomain = customDomain ?? stagingDomain ?? null;
  const baseDomain    = (selectedDomain && allowlist.includes(selectedDomain))
    ? selectedDomain : defaultDomain;

  const rawPages = pages.filter(p => !p.draft && !p.archived);

  const cmsResolutions = await Promise.all(
    rawPages.map(async p => {
      if (!p.collectionId) return null;
      try {
        const r = await fetch(
          `https://api.webflow.com/v2/collections/${p.collectionId}/items/live?limit=1`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!r.ok) return null;
        const d    = await r.json();
        const item = d.items?.[0];
        const slug = item?.fieldData?.slug ?? item?.slug ?? null;
        return slug ? { collectionId: p.collectionId, slug } : null;
      } catch { return null; }
    })
  );

  const cmsSlugMap = {};
  for (const r of cmsResolutions) {
    if (r) cmsSlugMap[r.collectionId] = r.slug;
  }

  return {
    pages: rawPages
      .map(p => {
        let path = p.publishedPath ?? `/${p.slug ?? ''}`;
        if (p.collectionId && cmsSlugMap[p.collectionId]) {
          path = path.replace(/\{[^}]+\}/, cmsSlugMap[p.collectionId]);
        }
        const pageUrl = baseDomain ? `https://${baseDomain}${path}` : null;
        return {
          pageId:        p.id,
          title:         p.title ?? p.slug ?? '',
          slug:          p.slug ?? '',
          path,
          url:           pageUrl,
          isCmsTemplate: !!p.collectionId,
          collectionId:  p.collectionId ?? null,
          parentId:      p.parentId ?? null,
        };
      })
      .filter(p => p.url),
    domains: allowlist,
  };
}
