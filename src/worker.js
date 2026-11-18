import { handleAuthorize, handleCallback, handleMe, getStoredAuth } from './auth/oauth.js';
import { handleDesignerToken } from './auth/designerToken.js';
import { verifySessionToken } from './auth/jwt.js';
import { runScan } from './scanner.js';
import { validateDomainOwnership } from './lib/domains.js';
import { listSitePages } from './lib/pages.js';
import { handleQueue, handleCron } from './queue/consumer.js';
import { BrowserSemaphore } from './durable-objects/BrowserSemaphore.js';
import {
  handleCreateJob,
  handleGetActiveJob,
  handleGetJob,
  handleGetPageResult,
  handleCancelJob,
} from './routes/jobs.js';

export { BrowserSemaphore };

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const pathname = url.pathname;
    const method   = request.method;

    const requestOrigin = request.headers.get('Origin') || '';
    const allowedOrigins = [
      'https://webflow.com',
      ...(env.ENVIRONMENT === 'development'
        ? ['http://localhost:1337', 'http://127.0.0.1:1337']
        : []),
    ];
    const isAllowedOrigin =
      allowedOrigins.includes(requestOrigin) ||
      requestOrigin.endsWith('.webflow-ext.com') ||
      requestOrigin.endsWith('.webflow.com');

    const corsOrigin = isAllowedOrigin ? requestOrigin : null;
    const cors = corsOrigin ? {
      'Access-Control-Allow-Origin':  corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
    } : {};

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const reqId = crypto.randomUUID().slice(0, 8);

    try {
      // ── Auth routes (no session required) ────────────────────────────────────

      if (pathname === '/oauth/install' && method === 'GET') {
        return handleAuthorize(request, env);
      }
      if (pathname === '/api/scanner/auth/authorize' && method === 'GET') {
        return handleAuthorize(request, env);
      }
      if (pathname === '/api/scanner/auth/callback' && method === 'GET') {
        return handleCallback(request, env);
      }
      if (pathname === '/api/scanner/auth/designer-token' && method === 'POST') {
        return withCors(await handleDesignerToken(request, env), cors);
      }

      // ── Protected routes ─────────────────────────────────────────────────────

      if (pathname === '/api/scanner/auth/me' && method === 'GET') {
        const req = await requireSession(request, env);
        return withCors(await handleMe(req, env), cors);
      }

      // Single-page scan (still used for preview / on-demand)
      if (pathname === '/api/scanner/scan' && method === 'POST') {
        const req  = await requireSession(request, env);
        const body = await req.json();

        if (!body.pageUrl || typeof body.pageUrl !== 'string' || body.pageUrl.length > 2048) {
          return withCors(jsonResponse({ error: 'pageUrl is required and must be under 2048 chars' }, 400), cors);
        }

        await validateDomainOwnership(body.pageUrl, req._claims.siteId, req._accessToken, env);
        await checkRateLimit(req._claims.siteId, env);

        const result = await runScan({
          siteId:  req._claims.siteId,
          pageUrl: body.pageUrl,
          pageId:  body.pageId ?? null,
          env,
        });

        await saveScanToHistory(result, req._claims.siteId, env);
        return withCors(jsonResponse(result), cors);
      }

      // Pages list
      const pagesMatch = pathname.match(/^\/api\/scanner\/sites\/([^/]+)\/pages$/);
      if (pagesMatch && method === 'GET') {
        const req = await requireSession(request, env);
        if (req._claims.siteId !== pagesMatch[1]) {
          return withCors(jsonResponse({ error: 'Forbidden' }, 403), cors);
        }
        const selectedDomain = url.searchParams.get('domain') ?? null;
        const { pages, domains } = await listSitePages(pagesMatch[1], req._accessToken, env, selectedDomain);
        return withCors(jsonResponse({ pages, domains }), cors);
      }

      // ── Queue-backed job routes ───────────────────────────────────────────────

      if (pathname === '/api/scanner/jobs' && method === 'POST') {
        const req = await requireSession(request, env);
        const result = await handleCreateJob(req, env);
        return withCors(jsonResponse(result, 201), cors);
      }

      if (pathname === '/api/scanner/jobs/active' && method === 'GET') {
        const req = await requireSession(request, env);
        const result = await handleGetActiveJob(req, env);
        return withCors(jsonResponse(result ?? null), cors);
      }

      const jobMatch = pathname.match(/^\/api\/scanner\/jobs\/([^/]+)$/);
      if (jobMatch && method === 'GET') {
        const req = await requireSession(request, env);
        const result = await handleGetJob(req, env, jobMatch[1]);
        return withCors(jsonResponse(result), cors);
      }

      const cancelMatch = pathname.match(/^\/api\/scanner\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const req = await requireSession(request, env);
        const result = await handleCancelJob(req, env, cancelMatch[1]);
        return withCors(jsonResponse(result), cors);
      }

      const pageResultMatch = pathname.match(/^\/api\/scanner\/jobs\/([^/]+)\/pages\/([^/]+)$/);
      if (pageResultMatch && method === 'GET') {
        const req = await requireSession(request, env);
        return handleGetPageResult(req, env, pageResultMatch[1], pageResultMatch[2]);
      }

      // ── Scan history ─────────────────────────────────────────────────────────

      if (pathname === '/api/scanner/history' && method === 'GET') {
        const req = await requireSession(request, env);
        const raw = await env.TOKENS.get(`scanner:history:${req._claims.siteId}`);
        return withCors(jsonResponse({ entries: raw ? JSON.parse(raw) : [] }), cors);
      }

      if (pathname.startsWith('/api/scanner/history/') && method === 'GET') {
        const req    = await requireSession(request, env);
        const scanId = pathname.split('/').pop();
        const raw    = await env.TOKENS.get(`scanner:scan:${scanId}`);
        if (!raw) return withCors(jsonResponse({ error: 'Scan not found' }, 404), cors);
        const scan = JSON.parse(raw);
        if (scan.siteId !== req._claims.siteId) {
          return withCors(jsonResponse({ error: 'Forbidden' }, 403), cors);
        }
        return withCors(jsonResponse(scan), cors);
      }

      // ── Health ───────────────────────────────────────────────────────────────

      if (pathname === '/health') {
        return withCors(jsonResponse({ status: 'ok', version: '3.0.0' }), cors);
      }

      return withCors(jsonResponse({ error: 'Not found' }, 404), cors);

    } catch (err) {
      const status = err.status ?? 500;
      const extra  = {};
      if (err.remaining !== undefined) extra.remaining = err.remaining;
      if (err.limit !== undefined)     extra.limit = err.limit;
      if (err.runningJobId !== undefined) extra.runningJobId = err.runningJobId;

      if (status >= 500) {
        console.error(`[${reqId}] [${status}]`, err.message, err.stack);
        return withCors(jsonResponse({ error: 'An internal error occurred.', reqId }, 500), cors);
      }
      console.error(`[${reqId}] [${status}]`, err.message);
      return withCors(jsonResponse({ error: err.message, ...extra }, status), cors);
    }
  },

  // ── Queue consumer ────────────────────────────────────────────────────────────
  async queue(batch, env) {
    return handleQueue(batch, env);
  },

  // ── Cron trigger ─────────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event, env));
  },
};

// ── Scan history ──────────────────────────────────────────────────────────────

async function saveScanToHistory(result, siteId, env) {
  try {
    const scanId = `${siteId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await env.TOKENS.put(`scanner:scan:${scanId}`, JSON.stringify({ ...result, scanId }), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
    const historyKey = `scanner:history:${siteId}`;
    const historyRaw = await env.TOKENS.get(historyKey);
    const history    = historyRaw ? JSON.parse(historyRaw) : [];
    history.unshift({ scanId, pageUrl: result.pageUrl, scannedAt: result.scannedAt, durationMs: result.durationMs, summary: result.summary });
    if (history.length > 20) history.splice(20);
    await env.TOKENS.put(historyKey, JSON.stringify(history));
  } catch (err) {
    console.error('Failed to save scan history:', err.message);
  }
}

// ── Rate limiting (single-page scans only) ────────────────────────────────────

async function checkRateLimit(siteId, env) {
  const DAILY_LIMIT = 500;
  const today = new Date().toISOString().slice(0, 10);
  const key   = `scanner:ratelimit:${siteId}:${today}`;
  const raw   = await env.TOKENS.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= DAILY_LIMIT) {
    throw Object.assign(
      new Error(`Daily scan limit of ${DAILY_LIMIT} reached. Resets at midnight UTC.`),
      { status: 429 }
    );
  }
  await env.TOKENS.put(key, String(count + 1), { expirationTtl: 60 * 60 * 25 });
}

// ── Session middleware ────────────────────────────────────────────────────────

async function requireSession(request, env) {
  const authHeader = request.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });

  const claims = await verifySessionToken(env, token).catch(() => {
    throw Object.assign(new Error('Invalid or expired session token'), { status: 401 });
  });

  const stored = await getStoredAuth(claims.siteId, env);
  if (!stored) throw Object.assign(new Error('Session not found — please reconnect'), { status: 401 });

  request._claims      = claims;
  request._accessToken = stored.accessToken;
  return request;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withCors(response, corsHeaders) {
  if (!corsHeaders || !Object.keys(corsHeaders).length) return response;
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeaders)) r.headers.set(k, v);
  return r;
}
