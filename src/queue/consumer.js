/**
 * Queue consumer — processes batches of page scan messages.
 * Also handles the dead-letter queue and the cron sweep.
 *
 * Message format: { jobId: string, pageIds: string[] }
 */

import { runScan } from '../scanner.js';
import { getStoredAuth } from '../auth/oauth.js';
import { getAllowedDomains } from '../lib/domains.js';
import { acquireBrowserSlot, releaseBrowserSlot } from '../durable-objects/BrowserSemaphore.js';

// ── Main queue consumer ───────────────────────────────────────────────────────

export async function handleQueue(batch, env) {
  const isDlq = batch.queue === 'accessibility-scan-dlq';
  if (isDlq) {
    await handleDlqBatch(batch, env);
    return;
  }
  await handleScanBatch(batch, env);
}

async function handleScanBatch(batch, env) {
  for (const message of batch.messages) {
    await processScanMessage(message, env);
  }
}

async function processScanMessage(message, env) {
  const { jobId, pageIds } = message.body ?? {};
  if (!jobId || !Array.isArray(pageIds) || !pageIds.length) {
    message.ack();
    return;
  }

  // Load job from D1
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first();
  if (!job) { message.ack(); return; }

  // Job was cancelled or already finished — refund reserved pages and ack
  if (job.status === 'cancelled' || job.status === 'done' || job.status === 'failed') {
    await refundPages(jobId, pageIds, env);
    message.ack();
    return;
  }

  // Verify stored auth still exists
  const stored = await getStoredAuth(job.site_id, env);
  if (!stored) {
    await markPagesFailed(jobId, pageIds, 'Site auth no longer valid', env);
    await maybeFinishJob(jobId, env);
    message.ack();
    return;
  }

  // Re-verify domain allowlist at scan time
  const allowlist = await getAllowedDomains(job.site_id, stored.accessToken, env);

  // Load the specific pages from D1
  const placeholders = pageIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT * FROM job_pages WHERE job_id = ? AND page_id IN (${placeholders})`
  ).bind(jobId, ...pageIds).all();

  const pages = rows.results ?? [];

  // Acquire browser semaphore slot
  let leaseId = null;
  const slot = await acquireBrowserSlot(env, job.site_id);
  if (!slot.acquired) {
    // No slot — retry after delay (does not count as a failed attempt)
    message.retry({ delaySeconds: 30 });
    return;
  }
  leaseId = slot.leaseId;

  try {
    // Launch one browser for the whole batch
    for (const p of pages) {
      await processOnePage(p, job, allowlist, stored.accessToken, env);
    }
  } finally {
    await releaseBrowserSlot(env, leaseId);
  }

  await maybeFinishJob(jobId, env);
  message.ack();
}

async function processOnePage(pageRow, job, allowlist, accessToken, env) {
  const { job_id, page_id, url, is_cms } = pageRow;

  // Validate domain is still allowed
  let hostname;
  try { hostname = new URL(url).hostname; } catch {
    await markPageFailed(job_id, page_id, 'Invalid URL', env);
    return;
  }
  if (!allowlist.includes(hostname)) {
    await markPageFailed(job_id, page_id, 'Domain no longer in allowlist', env);
    return;
  }

  // Claim the page (guards against duplicate delivery)
  const claim = await env.DB.prepare(
    `UPDATE job_pages
       SET status = 'running', attempts = attempts + 1, updated_at = datetime('now')
     WHERE job_id = ? AND page_id = ? AND status IN ('queued','running') AND attempts < 3`
  ).bind(job_id, page_id).run();

  if (!claim.meta.changes) return; // already claimed or max attempts reached

  try {
    const result = await runScan({
      siteId:  job.site_id,
      pageUrl: url,
      pageId:  page_id,
      env,
    });

    // Write full result to R2
    const r2Key = `results/${job.site_id}/${job_id}/${page_id}.json`;
    await env.RESULTS.put(r2Key, JSON.stringify(result), {
      httpMetadata: { contentType: 'application/json' },
    });

    // Write summary + issues to D1 and mark done
    await env.DB.prepare(
      `UPDATE job_pages
         SET status = 'done', summary_json = ?, r2_key = ?, error = NULL, updated_at = datetime('now')
       WHERE job_id = ? AND page_id = ? AND status = 'running'`
    ).bind(JSON.stringify({ ...result.summary, issues: result.issues ?? [] }), r2Key, job_id, page_id).run();

    await bumpJobCounter(job_id, 'done_pages', env);

  } catch (err) {
    const isSkippable = err.status === 422;
    const reason = err.message ?? 'Scan failed';

    if (isSkippable) {
      await env.DB.prepare(
        `UPDATE job_pages
           SET status = 'skipped', error = ?, updated_at = datetime('now')
         WHERE job_id = ? AND page_id = ? AND status = 'running'`
      ).bind(reason, job_id, page_id).run();
      await bumpJobCounter(job_id, 'skipped_pages', env);
    } else {
      await markPageFailed(job_id, page_id, reason, env);
    }
  }
}

async function bumpJobCounter(jobId, column, env) {
  await env.DB.prepare(
    `UPDATE jobs SET ${column} = ${column} + 1, started_at = COALESCE(started_at, datetime('now'))
     WHERE job_id = ? AND status IN ('queued','running')`
  ).bind(jobId).run();

  // Flip status to running once first page is touched
  await env.DB.prepare(
    `UPDATE jobs SET status = 'running' WHERE job_id = ? AND status = 'queued'`
  ).bind(jobId).run();
}

async function maybeFinishJob(jobId, env) {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first();
  if (!job) return;

  const settled = job.done_pages + job.failed_pages + job.skipped_pages;
  if (settled < job.total_pages) return;
  if (!['queued','running'].includes(job.status)) return;

  const finalStatus = job.failed_pages === job.total_pages ? 'failed' : 'done';

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = ?, finished_at = datetime('now')
       WHERE job_id = ? AND status IN ('queued','running')`
    ).bind(finalStatus, jobId),
    // Settle usage: move done pages to used, release the rest
    env.DB.prepare(
      `UPDATE usage
         SET pages_used      = pages_used + ?,
             pages_reserved  = pages_reserved - ?
       WHERE site_id = ? AND period = strftime('%Y-%m', 'now')`
    ).bind(job.done_pages, job.reserved_pages, job.site_id),
  ]);

  if (finalStatus === 'done') {
    await writeJobToHistory(jobId, job.site_id, env);
  }
}

async function writeJobToHistory(jobId, siteId, env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT page_id, url, title, summary_json, updated_at FROM job_pages
       WHERE job_id = ? AND status = 'done' ORDER BY updated_at`
    ).bind(jobId).all();

    const historyKey = `scanner:history:${siteId}`;
    const historyRaw = await env.TOKENS.get(historyKey);
    const history = historyRaw ? JSON.parse(historyRaw) : [];

    const scannedAt = new Date().toISOString();

    for (const p of rows.results ?? []) {
      const summary = p.summary_json ? JSON.parse(p.summary_json) : {};
      const { issues, ...summaryOnly } = summary;
      const scanId = `${siteId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      await env.TOKENS.put(`scanner:scan:${scanId}`, JSON.stringify({
        scanId, siteId, pageUrl: p.url, scannedAt, durationMs: 0,
        summary: summaryOnly, issues: issues ?? [],
      }), { expirationTtl: 60 * 60 * 24 * 30 });

      history.unshift({ scanId, pageUrl: p.url, scannedAt, durationMs: 0, summary: summaryOnly });
    }

    if (history.length > 50) history.splice(50);
    await env.TOKENS.put(historyKey, JSON.stringify(history));
  } catch (err) {
    console.error('Failed to write job history:', err.message);
  }
}

async function markPageFailed(jobId, pageId, reason, env) {
  const changed = await env.DB.prepare(
    `UPDATE job_pages SET status = 'failed', error = ?, updated_at = datetime('now')
     WHERE job_id = ? AND page_id = ? AND status NOT IN ('done','skipped')`
  ).bind(reason, jobId, pageId).run();

  if (changed.meta.changes) await bumpJobCounter(jobId, 'failed_pages', env);
}

async function markPagesFailed(jobId, pageIds, reason, env) {
  for (const pageId of pageIds) {
    await markPageFailed(jobId, pageId, reason, env);
  }
}

async function refundPages(jobId, pageIds, env) {
  // If a job was cancelled the quota was already refunded on cancel; this is a no-op guard
}

// ── Dead-letter queue consumer ────────────────────────────────────────────────

async function handleDlqBatch(batch, env) {
  for (const message of batch.messages) {
    const { jobId, pageIds } = message.body ?? {};
    if (!jobId || !Array.isArray(pageIds)) { message.ack(); continue; }

    for (const pageId of pageIds) {
      await markPageFailed(jobId, pageId, 'Exhausted retries (DLQ)', env);
    }
    await maybeFinishJob(jobId, env);
    message.ack();
  }
}

// ── Cron sweep — runs every 5 minutes ────────────────────────────────────────

export async function handleCron(event, env) {
  await Promise.allSettled([
    sweepStuckPages(env),
    sweepStuckJobs(env),
  ]);
}

async function sweepStuckPages(env) {
  // Pages stuck in 'running' for > 10 minutes: re-queue or fail after 3 attempts
  const stuck = await env.DB.prepare(
    `SELECT job_id, page_id, attempts FROM job_pages
     WHERE status = 'running'
       AND updated_at < datetime('now', '-10 minutes')`
  ).all();

  for (const row of stuck.results ?? []) {
    if (row.attempts >= 3) {
      await markPageFailed(row.job_id, row.page_id, 'Timed out after 3 attempts', env);
      await maybeFinishJob(row.job_id, env);
    } else {
      // Reset to queued — the job will be re-queued by the job sweep
      await env.DB.prepare(
        `UPDATE job_pages SET status = 'queued', updated_at = datetime('now')
         WHERE job_id = ? AND page_id = ? AND status = 'running'`
      ).bind(row.job_id, row.page_id).run();
    }
  }
}

async function sweepStuckJobs(env) {
  // Jobs older than 6 hours that never finished: force-finalise
  const old = await env.DB.prepare(
    `SELECT job_id, site_id, reserved_pages FROM jobs
     WHERE status IN ('queued','running')
       AND created_at < datetime('now', '-6 hours')`
  ).all();

  for (const job of old.results ?? []) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE jobs SET status = 'failed', finished_at = datetime('now')
         WHERE job_id = ? AND status IN ('queued','running')`
      ).bind(job.job_id),
      env.DB.prepare(
        `UPDATE usage SET pages_reserved = MAX(0, pages_reserved - ?)
         WHERE site_id = ? AND period = strftime('%Y-%m', 'now')`
      ).bind(job.reserved_pages, job.site_id),
    ]);
  }
}
