/**
 * Accessibility Scanner — Cloudflare Browser Rendering + axe-core
 *
 * Uses @cloudflare/puppeteer to launch a real browser, navigate to the target
 * URL, inject axe-core, and run a full WCAG 2.1 AA accessibility audit.
 *
 * Requires the [browser] binding in wrangler.toml:
 *   [browser]
 *   binding = "MY_BROWSER"
 *
 * And Browser Rendering enabled in your Cloudflare dashboard:
 *   Workers & Pages → Browser Rendering
 */

import puppeteer from '@cloudflare/puppeteer';
import axeSource from 'axe-core/axe.min.js';

const SCANNER_UA = 'AccessibilityChecker/1.0 (+https://accessibility-checker-webflow.web-8fb.workers.dev/bot)';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Analytics/tracker domains to block during scan (prevents polluting client analytics)
const BLOCKED_TRACKER_PATTERNS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'facebook.net',
  'facebook.com/tr',
  'connect.facebook.net',
  'hotjar.com',
  'clarity.ms',
  'segment.com',
  'segment.io',
  'mixpanel.com',
  'amplitude.com',
  'fullstory.com',
  'heap.io',
  'intercom.io',
  'crisp.chat',
  'hubspot.com/analytics',
  'hs-analytics.net',
  'doubleclick.net',
  'adservice.google.com',
  'scorecardresearch.com',
  'quantserve.com',
];

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runScan({ siteId, pageUrl, pageId, token, env }) {
  const startedAt = Date.now();

  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(pageUrl);
  } catch {
    throw Object.assign(new Error(`Invalid URL: ${pageUrl}`), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw Object.assign(new Error('URL must use HTTP or HTTPS'), { status: 400 });
  }

  if (!env.MY_BROWSER) {
    throw Object.assign(
      new Error('Browser Rendering not configured. Enable it in Cloudflare dashboard and add [browser] binding to wrangler.toml.'),
      { status: 500 }
    );
  }

  // Hard 60 s overall timeout — prevents a hanging page from tying up the worker
  const scanTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error('Scan timed out after 60 s'), { status: 504 })), 60_000)
  );

  return Promise.race([_runScan({ siteId, pageUrl, pageId, startedAt, env }), scanTimeout]);
}

async function _runScan({ siteId, pageUrl, pageId, startedAt, env }) {
  let browser;
  try {
    browser = await puppeteer.launch(env.MY_BROWSER);
    const page = await browser.newPage();

    // Identify scanner in HTTP logs; site owners can filter these hits from analytics
    await page.setUserAgent(SCANNER_UA);
    await page.setExtraHTTPHeaders({ 'X-Accessibility-Scan': '1' });

    // Bypass CSP so we can inject axe-core
    await page.setBypassCSP(true);

    // Block analytics/trackers AND private-IP redirects (SSRF defence)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const reqUrl = req.url();

      // Block redirects to private/loopback ranges
      try {
        const { hostname, protocol } = new URL(reqUrl);
        if (!['http:', 'https:'].includes(protocol)) { req.abort(); return; }
        if (
          /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
          hostname === 'localhost' ||
          hostname.endsWith('.internal') ||
          hostname.endsWith('.local')
        ) { req.abort(); return; }
      } catch { req.abort(); return; }

      const shouldBlock = BLOCKED_TRACKER_PATTERNS.some(pattern => reqUrl.includes(pattern));
      if (shouldBlock) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate — networkidle2 waits until no more than 2 active connections,
    // catching most async content loads without hanging on long-polling sites.
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // S13: Detect auth redirects using hostname comparison (not substring match)
    // and Webflow password-page detection via the /.wf_auth form action.
    const finalUrl      = page.url();
    const originalHost  = new URL(pageUrl).hostname;
    const finalHost     = new URL(finalUrl).hostname;
    const redirectedAway = finalHost !== originalHost;

    // Webflow password-protected pages post to /.wf_auth
    const isWfPasswordPage = await page.evaluate(() =>
      !!document.querySelector('form[action="/.wf_auth"]')
    ).catch(() => false);

    if (redirectedAway || isWfPasswordPage) {
      const reason = isWfPasswordPage
        ? 'This page is password-protected. Scanner cannot access gated content.'
        : `Page redirected to ${finalHost} — this page may require login. Scanner cannot access gated content.`;
      throw Object.assign(new Error(reason), { status: 422 });
    }

    // Scroll to trigger lazy-loaded content
    await page.evaluate(() => {
      window.scrollTo(0, Math.floor(document.body.scrollHeight / 2));
    });
    await sleep(600);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(600);
    await page.evaluate(() => { window.scrollTo(0, 0); });

    // Inject bundled axe-core (no CDN dependency; deterministic version)
    await page.addScriptTag({ content: axeSource });

    // Run axe — WCAG 2.1 + 2.2 A/AA
    const axeResults = await page.evaluate(() => {
      return window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'],
        },
        resultTypes: ['violations', 'passes', 'incomplete'],
        iframes: true,
      });
    });

    return processAxeResults(axeResults, pageUrl, siteId, pageId, startedAt);

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


// ── Result processing ─────────────────────────────────────────────────────────

function processAxeResults(axeResults, pageUrl, siteId, pageId, startedAt) {
  const violations = axeResults.violations ?? [];
  const bestPracticeViolations = [];
  const accessibilityViolations = [];

  for (const v of violations) {
    const isBestPractice =
      v.tags.includes('best-practice') &&
      !v.tags.some(t => t.startsWith('wcag'));

    if (isBestPractice) {
      bestPracticeViolations.push(v);
    } else {
      accessibilityViolations.push(v);
    }
  }

  const issues = flattenViolations(accessibilityViolations, 'accessibility');
  const bestPracticeIssues = flattenViolations(bestPracticeViolations, 'best-practice');
  const allIssues = [...issues, ...bestPracticeIssues];

  const summary = buildSummary(allIssues, axeResults.passes ?? [], axeResults.incomplete ?? []);

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    pageUrl,
    pageId: pageId ?? null,
    siteId: siteId ?? null,
    summary,
    issues: allIssues,
    passesCount: (axeResults.passes ?? []).length,
    incompleteCount: (axeResults.incomplete ?? []).length,
  };
}

function flattenViolations(violations, category) {
  const issues = [];

  for (const v of violations) {
    const wcag  = extractWcagCriteria(v.tags);
    const level = extractWcagLevel(v.tags);

    for (const node of v.nodes) {
      // Sanitize: never store raw DOM HTML from the scanned page.
      // Keep only: rule ID, impact, WCAG tags, CSS selector, trimmed failure summary.
      const rawSummary = node.failureSummary ?? v.help ?? '';
      issues.push({
        rule:     v.id,
        impact:   v.impact,
        wcag,
        level,
        target:   node.target?.[0] ?? null,          // CSS selector only
        howToFix: stripHtml(truncate(rawSummary, 300)),
        // Static axe-core fields — not sourced from the scanned page
        message:  v.description,
        helpUrl:  v.helpUrl,
        category,
      });
    }
  }

  return issues;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractWcagCriteria(tags) {
  const match = tags
    .filter(t => /^wcag\d{3,}/.test(t))
    .map(t => {
      const digits = t.replace('wcag', '');
      if (digits.length >= 3) {
        const parts = digits.split('');
        return `${parts[0]}.${parts[1]}.${parts.slice(2).join('')}`;
      }
      return null;
    })
    .filter(Boolean);

  return match[0] ?? '';
}

function extractWcagLevel(tags) {
  if (tags.includes('wcag2aa') || tags.includes('wcag21aa') || tags.includes('wcag22aa')) return 'AA';
  if (tags.includes('wcag2a') || tags.includes('wcag21a') || tags.includes('wcag22a')) return 'A';
  return '';
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

// Remove any HTML tags that might appear in axe failure summaries
function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function buildSummary(issues, passes, incomplete) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const rulesSeen = new Set();

  for (const i of issues) {
    counts[i.impact] = (counts[i.impact] ?? 0) + 1;
    rulesSeen.add(i.rule);
  }

  const accessibilityIssues = issues.filter(i => i.category === 'accessibility');
  const bestPracticeIssues = issues.filter(i => i.category === 'best-practice');

  // Score: 100 minus weighted deductions
  const score = Math.max(
    0,
    100 -
      counts.critical * 10 -
      counts.serious * 5 -
      counts.moderate * 2 -
      counts.minor * 1
  );

  return {
    total: issues.length,
    accessibility: accessibilityIssues.length,
    bestPractice: bestPracticeIssues.length,
    byCritical: counts.critical,
    bySerious: counts.serious,
    byModerate: counts.moderate,
    byMinor: counts.minor,
    uniqueRules: rulesSeen.size,
    passedRules: passes.length,
    incompleteRules: incomplete.length,
    score,
  };
}
