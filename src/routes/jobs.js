/**
 * Job CRUD routes — POST /api/scanner/jobs, GET active/by-id, cancel, page result
 */

import { listSitePages } from '../lib/pages.js';
import { validateDomainOwnership } from '../lib/domains.js';

const MAX_PAGE_IDS = 1000;

// ── POST /api/scanner/jobs ────────────────────────────────────────────────────

export async function handleCreateJob(request, env) {
  const { siteId, userId } = request._claims;
  const accessToken = request._accessToken;

  let body;
  try { body = await request.json(); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }

  // Validate body shape
  const pageIds = body.pageIds;
  if (!Array.isArray(pageIds) || pageIds.length === 0) {
    throw Object.assign(new Error('pageIds must be a non-empty array'), { status: 400 });
  }
  if (pageIds.length > MAX_PAGE_IDS) {
    throw Object.assign(new Error(`pageIds exceeds maximum of ${MAX_PAGE_IDS}`), { status: 400 });
  }
  if (pageIds.some(id => typeof id !== 'string' || id.length > 128)) {
    throw Object.assign(new Error('pageIds must be strings of at most 128 characters'), { status: 400 });
  }
  const uniqueIds = [...new Set(pageIds)];

  // Validate domain if provided
  const requestedDomain = typeof body.domain === 'string' && body.domain.length <= 253
    ? body.domain : null;

  // Load entitlement — fail closed if missing (billing not wired yet: use defaults)
  const entitlement = await loadEntitlement(siteId, env);

  // Rebuild page list server-side; ignore client-supplied URLs
  const { pages: allPages } = await listSitePages(siteId, accessToken, env, requestedDomain);

  // Keep only IDs the caller requested AND that the server knows about
  const pageMap = new Map(allPages.map(p => [p.pageId, p]));
  const selectedPages = uniqueIds.map(id => pageMap.get(id)).filter(Boolean);

  if (selectedPages.length === 0) {
    throw Object.assign(new Error('None of the provided pageIds are valid for this site'), { status: 400 });
  }

  // Enforce pages_per_scan limit
  if (selectedPages.length > entitlement.pages_per_scan) {
    throw Object.assign(
      new Error(`Selection of ${selectedPages.length} pages exceeds your plan limit of ${entitlement.pages_per_scan}.`),
      { status: 402, limit: entitlement.pages_per_scan, count: selectedPages.length }
    );
  }

  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const count  = selectedPages.length;

  // Atomic quota reservation
  const reserved = await env.DB.prepare(
    `INSERT INTO usage (site_id, period, pages_reserved, pages_used)
       VALUES (?, ?, ?, 0)
     ON CONFLICT (site_id, period) DO UPDATE
       SET pages_reserved = pages_reserved + ?
     WHERE pages_used + pages_reserved + ? <= ?`
  ).bind(siteId, period, count, count, count, entitlement.pages_per_month).run();

  if (!reserved.meta.changes) {
    const row = await env.DB.prepare(
      'SELECT pages_used, pages_reserved FROM usage WHERE site_id = ? AND period = ?'
    ).bind(siteId, period).first();
    const remaining = entitlement.pages_per_month - (row?.pages_used ?? 0) - (row?.pages_reserved ?? 0);
    throw Object.assign(
      new Error(`Monthly quota exceeded. ${Math.max(0, remaining)} pages remaining.`),
      { status: 402, remaining: Math.max(0, remaining) }
    );
  }

  // Create job and pages in one D1 batch
  const jobId = crypto.randomUUID();
  const domain = selectedPages[0]?.url ? new URL(selectedPages[0].url).hostname : null;

  const insertJob = env.DB.prepare(
    `INSERT INTO jobs (job_id, site_id, created_by, status, total_pages, reserved_pages, domain, plan_at_create)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
  ).bind(jobId, siteId, userId ?? siteId, count, count, domain, entitlement.plan);

  const insertPages = selectedPages.map(p =>
    env.DB.prepare(
      `INSERT INTO job_pages (job_id, page_id, url, title, is_cms, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`
    ).bind(jobId, p.pageId, p.url, p.title ?? '', p.isCmsTemplate ? 1 : 0)
  );

  try {
    await env.DB.batch([insertJob, ...insertPages]);
  } catch (err) {
    // Unique index on (site_id) for active jobs rejected → another job is running
    if (err.message?.includes('UNIQUE constraint')) {
      // Release the reservation we just made
      await env.DB.prepare(
        `UPDATE usage SET pages_reserved = MAX(0, pages_reserved - ?)
         WHERE site_id = ? AND period = ?`
      ).bind(count, siteId, period).run();

      const running = await env.DB.prepare(
        `SELECT job_id FROM jobs WHERE site_id = ? AND status IN ('queued','running') LIMIT 1`
      ).bind(siteId).first();

      throw Object.assign(
        new Error('A scan is already running for this site.'),
        { status: 409, runningJobId: running?.job_id ?? null }
      );
    }
    throw err;
  }

  // Send messages — batch pageIds (5 per message)
  const BATCH_SIZE = 5;
  const messages = [];
  for (let i = 0; i < selectedPages.length; i += BATCH_SIZE) {
    const slice = selectedPages.slice(i, i + BATCH_SIZE).map(p => p.pageId);
    messages.push({ body: { jobId, pageIds: slice } });
  }
  await env.SCAN_QUEUE.sendBatch(messages);

  return { jobId, total: count };
}

// ── GET /api/scanner/jobs/active ─────────────────────────────────────────────

export async function handleGetActiveJob(request, env) {
  const { siteId } = request._claims;
  const job = await env.DB.prepare(
    `SELECT * FROM jobs WHERE site_id = ? AND status IN ('queued','running') LIMIT 1`
  ).bind(siteId).first();

  if (!job) return null;
  return formatJobResponse(job, false);
}

// ── GET /api/scanner/jobs/:jobId ─────────────────────────────────────────────

export async function handleGetJob(request, env, jobId) {
  const { siteId } = request._claims;
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first();

  // Always 404 — prevents job ID probing
  if (!job || job.site_id !== siteId) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }

  const isDone = ['done','failed','cancelled'].includes(job.status);

  // Always include pages (during scan: status/url/title only; on done: full summary)
  // Order: running first, then done/skipped/failed by recency, then queued
  const rows = await env.DB.prepare(
    `SELECT * FROM job_pages WHERE job_id = ?
     ORDER BY
       CASE status WHEN 'running' THEN 0 WHEN 'done' THEN 1 WHEN 'skipped' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
       updated_at DESC`
  ).bind(jobId).all();

  const pages = (rows.results ?? []).map(p => ({
    pageId:  p.page_id,
    url:     p.url,
    title:   p.title,
    isCms:   !!p.is_cms,
    status:  p.status,
    error:   p.error ?? null,
    summary: (isDone && p.summary_json) ? JSON.parse(p.summary_json) : null,
  }));

  return { ...formatJobResponse(job, isDone), pages };
}

// ── GET /api/scanner/jobs/:jobId/pages/:pageId ────────────────────────────────

export async function handleGetPageResult(request, env, jobId, pageId) {
  const { siteId } = request._claims;
  const job = await env.DB.prepare('SELECT site_id FROM jobs WHERE job_id = ?').bind(jobId).first();
  if (!job || job.site_id !== siteId) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }

  const page = await env.DB.prepare(
    'SELECT r2_key FROM job_pages WHERE job_id = ? AND page_id = ?'
  ).bind(jobId, pageId).first();

  if (!page?.r2_key) {
    throw Object.assign(new Error('Result not available yet'), { status: 404 });
  }

  const obj = await env.RESULTS.get(page.r2_key);
  if (!obj) throw Object.assign(new Error('Result not found'), { status: 404 });

  return new Response(obj.body, {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── POST /api/scanner/jobs/:jobId/cancel ──────────────────────────────────────

export async function handleCancelJob(request, env, jobId) {
  const { siteId } = request._claims;
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first();
  if (!job || job.site_id !== siteId) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  if (!['queued','running'].includes(job.status)) {
    throw Object.assign(new Error('Job is not active'), { status: 409 });
  }

  // Cancel and release remaining reservation
  const queued = await env.DB.prepare(
    'SELECT COUNT(*) as n FROM job_pages WHERE job_id = ? AND status = ?'
  ).bind(jobId, 'queued').first();

  const toRefund = queued?.n ?? 0;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'cancelled', finished_at = datetime('now')
       WHERE job_id = ? AND status IN ('queued','running')`
    ).bind(jobId),
    env.DB.prepare(
      `UPDATE usage SET pages_reserved = MAX(0, pages_reserved - ?)
       WHERE site_id = ? AND period = strftime('%Y-%m', 'now')`
    ).bind(toRefund, siteId),
  ]);

  return { cancelled: true, jobId };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatJobResponse(job, full) {
  return {
    jobId:       job.job_id,
    status:      job.status,
    totalPages:  job.total_pages,
    donePages:   job.done_pages,
    failedPages: job.failed_pages,
    skippedPages: job.skipped_pages,
    createdAt:   job.created_at,
    startedAt:   job.started_at ?? null,
    finishedAt:  job.finished_at ?? null,
  };
}

async function loadEntitlement(siteId, env) {
  // Billing not wired yet — return a default permissive entitlement.
  // Replace this with a real DB lookup once billing is configured.
  const row = await env.DB.prepare(
    'SELECT * FROM entitlements WHERE site_id = ?'
  ).bind(siteId).first().catch(() => null);

  if (row && row.status === 'active') return row;

  // Default: no plan configured yet — allow unlimited
  return {
    plan:            'free',
    status:          'active',
    pages_per_scan:  1000,
    pages_per_month: 10000,
  };
}
