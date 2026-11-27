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

function isPrivateHost(hostname) {
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]' ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) return true;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return true;
  // IPv6 loopback / link-local
  if (/^::1$|^fe[89ab][0-9a-f]:/i.test(hostname.replace(/^\[|\]$/g, ''))) return true;
  return false;
}

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

// Launch a browser instance to be shared across multiple pages in a batch.
// Caller is responsible for closing it in a finally block.
export async function launchBrowser(env) {
  if (!env.MY_BROWSER) {
    throw Object.assign(
      new Error('Browser Rendering not configured.'),
      { status: 500 }
    );
  }
  return puppeteer.launch(env.MY_BROWSER);
}

// Scan a single page using an already-running browser instance.
// Opens a new tab, scans it, then closes the tab (not the browser).
export async function runScanOnPage({ browser, siteId, pageUrl, pageId, env }) {
  const startedAt = Date.now();

  let parsedUrl;
  try {
    parsedUrl = new URL(pageUrl);
  } catch {
    throw Object.assign(new Error(`Invalid URL: ${pageUrl}`), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw Object.assign(new Error('URL must use HTTP or HTTPS'), { status: 400 });
  }

  const scanTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error('Scan timed out after 60 s'), { status: 504 })), 60_000)
  );

  return Promise.race([_runScanOnPage({ browser, siteId, pageUrl, pageId, startedAt }), scanTimeout]);
}

// CSS injected on every page to suppress animations/transitions for deterministic layout
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

async function setupPage(page) {
  // Fixed viewport — prevents responsive breakpoints from causing different axe results
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent(SCANNER_UA);
  await page.setExtraHTTPHeaders({ 'X-Accessibility-Scan': '1' });
  await page.setBypassCSP(true);

  // Emulate prefers-reduced-motion so sites don't start animations
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]).catch(() => {});

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const reqUrl = req.url();
    try {
      const { hostname, protocol } = new URL(reqUrl);
      if (!['http:', 'https:'].includes(protocol)) { req.abort(); return; }
      if (isPrivateHost(hostname)) { req.abort(); return; }
    } catch { req.abort(); return; }
    const shouldBlock = BLOCKED_TRACKER_PATTERNS.some(pattern => reqUrl.includes(pattern));
    if (shouldBlock) { req.abort(); } else { req.continue(); }
  });
}

async function _runScanOnPage({ browser, siteId, pageUrl, pageId, startedAt }) {
  const page = await browser.newPage();
  try {
    await setupPage(page);

    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(400); // let any post-load JS settle

    const finalUrl     = page.url();
    const originalHost = new URL(pageUrl).hostname;
    const finalHost    = new URL(finalUrl).hostname;
    const redirectedAway = finalHost !== originalHost;
    const isWfPasswordPage = await page.evaluate(() =>
      !!document.querySelector('form[action="/.wf_auth"]')
    ).catch(() => false);

    if (redirectedAway || isWfPasswordPage) {
      const reason = isWfPasswordPage
        ? 'This page is password-protected. Scanner cannot access gated content.'
        : `Page redirected to ${finalHost} — this page may require login. Scanner cannot access gated content.`;
      throw Object.assign(new Error(reason), { status: 422 });
    }

    // Freeze animations before scrolling so layout is stable
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});

    await page.evaluate(() => { window.scrollTo(0, Math.floor(document.body.scrollHeight / 2)); });
    await sleep(600);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await sleep(600);
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await sleep(300);

    await page.addScriptTag({ content: axeSource });

    const axeResults = await page.evaluate(() => {
      return window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'],
        },
        rules: {
          'link-in-text-block':              { enabled: true },
          'target-size':                     { enabled: true },
          'region':                          { enabled: true },
          'bypass':                          { enabled: true },
          'meta-viewport':                   { enabled: true },
          'autocomplete-valid':              { enabled: true },
          'document-title':                  { enabled: true },
          'color-contrast':                  { enabled: true },
          'label-content-name-mismatch':     { enabled: true },
          'video-caption':                   { enabled: true },
          'audio-caption':                   { enabled: true },
          'aria-required-attr':              { enabled: true },
          'empty-heading':                   { enabled: true },
        },
        resultTypes: ['violations', 'passes', 'incomplete'],
        iframes: true,
      });
    });

    const customIssues = await runCustomChecks(page);
    const runtimeIssues = await runRuntimeChecks(page);

    return processAxeResults(axeResults, pageUrl, siteId, pageId, startedAt, [...customIssues, ...runtimeIssues]);
  } finally {
    await page.close().catch(() => {});
  }
}

async function _runScan({ siteId, pageUrl, pageId, startedAt, env }) {
  let browser;
  try {
    browser = await puppeteer.launch(env.MY_BROWSER);
    const page = await browser.newPage();

    await setupPage(page);

    // Navigate — networkidle2 waits until no more than 2 active connections
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(400); // let any post-load JS settle

    // Detect auth redirects and Webflow password pages
    const finalUrl      = page.url();
    const originalHost  = new URL(pageUrl).hostname;
    const finalHost     = new URL(finalUrl).hostname;
    const redirectedAway = finalHost !== originalHost;

    const isWfPasswordPage = await page.evaluate(() =>
      !!document.querySelector('form[action="/.wf_auth"]')
    ).catch(() => false);

    if (redirectedAway || isWfPasswordPage) {
      const reason = isWfPasswordPage
        ? 'This page is password-protected. Scanner cannot access gated content.'
        : `Page redirected to ${finalHost} — this page may require login. Scanner cannot access gated content.`;
      throw Object.assign(new Error(reason), { status: 422 });
    }

    // Freeze animations then scroll to trigger lazy-loaded content
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});

    await page.evaluate(() => { window.scrollTo(0, Math.floor(document.body.scrollHeight / 2)); });
    await sleep(600);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await sleep(600);
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await sleep(300);

    // Inject bundled axe-core (no CDN dependency; deterministic version)
    await page.addScriptTag({ content: axeSource });

    // Run axe — WCAG 2.1 + 2.2 A/AA
    const axeResults = await page.evaluate(() => {
      return window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice'],
        },
        rules: {
          'link-in-text-block':              { enabled: true },
          'target-size':                     { enabled: true },
          'region':                          { enabled: true },
          'bypass':                          { enabled: true },
          'meta-viewport':                   { enabled: true },
          'autocomplete-valid':              { enabled: true },
          'document-title':                  { enabled: true },
          'color-contrast':                  { enabled: true },
          'label-content-name-mismatch':     { enabled: true },
          'video-caption':                   { enabled: true },
          'audio-caption':                   { enabled: true },
          'aria-required-attr':              { enabled: true },
          'empty-heading':                   { enabled: true },
        },
        resultTypes: ['violations', 'passes', 'incomplete'],
        iframes: true,
      });
    });

    const customIssues = await runCustomChecks(page);
    const runtimeIssues = await runRuntimeChecks(page);

    return processAxeResults(axeResults, pageUrl, siteId, pageId, startedAt, [...customIssues, ...runtimeIssues]);

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


// ── Result processing ─────────────────────────────────────────────────────────

// Rules where axe's 'incomplete' verdict is high-signal enough to surface as needs-review
const SURFACED_INCOMPLETE_RULES = new Set(['color-contrast', 'color-contrast-enhanced', 'target-size']);

function processAxeResults(axeResults, pageUrl, siteId, pageId, startedAt, customIssues = []) {
  const violations = axeResults.violations ?? [];
  const bestPracticeViolations = [];
  const accessibilityViolations = [];

  for (const v of violations) {
    const isBestPractice =
      v.tags.includes('best-practice') &&
      !v.tags.some(t => t.startsWith('wcag'));
    if (isBestPractice) bestPracticeViolations.push(v);
    else accessibilityViolations.push(v);
  }

  const issues          = flattenViolations(accessibilityViolations, 'accessibility', 'confirmed');
  const bestPracticeIssues = flattenViolations(bestPracticeViolations, 'best-practice', 'confirmed');

  // Surface high-signal axe incomplete results (color-contrast, target-size) as needs-review
  const incompleteIssues = flattenIncompleteAxe(axeResults.incomplete ?? []);

  // Deduplicate custom/runtime issues against confirmed axe violations
  const axeRuleTargets = new Set(issues.map(i => i.rule + ':' + i.target));
  const filteredCustom = customIssues.filter(i => !axeRuleTargets.has(i.rule + ':' + i.target));

  const allIssues = [...issues, ...bestPracticeIssues, ...incompleteIssues, ...filteredCustom];

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

function flattenIncompleteAxe(incomplete) {
  const issues = [];
  for (const v of incomplete) {
    if (!SURFACED_INCOMPLETE_RULES.has(v.id)) continue;
    const wcag  = extractWcagCriteria(v.tags);
    const level = extractWcagLevel(v.tags);
    for (const node of v.nodes) {
      const checkMsg = node.any?.[0]?.message ?? node.all?.[0]?.message ?? v.help ?? '';
      issues.push({
        rule:          v.id,
        impact:        v.impact ?? 'moderate',
        wcag,
        level,
        target:        node.target?.[0] ?? null,
        html:          node.html ?? null,
        failureSummary: `Needs manual verification: ${stripHtml(checkMsg)}`,
        howToFix:      `Needs manual verification: ${stripHtml(checkMsg)}`,
        message:       v.description,
        helpUrl:       v.helpUrl,
        category:      'accessibility',
        status:        'needs-review',
      });
    }
  }
  return issues;
}

function flattenViolations(violations, category, status = 'confirmed') {
  const issues = [];

  for (const v of violations) {
    const wcag  = extractWcagCriteria(v.tags);
    const level = extractWcagLevel(v.tags);

    for (const node of v.nodes) {
      // Keep the full failureSummary — no truncation
      const rawSummary = stripHtml(node.failureSummary ?? v.help ?? '');
      issues.push({
        rule:          v.id,
        impact:        v.impact,
        wcag,
        level,
        target:        node.target?.[0] ?? null,
        html:          node.html ?? null,
        failureSummary: rawSummary,
        howToFix:      rawSummary,
        message:       v.description,
        helpUrl:       v.helpUrl,
        category,
        status,
      });
    }
  }

  return issues;
}

// Group a flat issue list into one entry per ruleId (used by the API response layer)
export function groupIssuesByRule(issues) {
  const map = new Map();
  for (const issue of issues) {
    const key = issue.rule;
    if (!map.has(key)) {
      map.set(key, {
        ruleId:        issue.rule,
        title:         issue.message,
        description:   issue.message,
        howToFix:      issue.howToFix,
        wcagTags:      issue.wcag ? [issue.wcag] : [],
        impact:        issue.impact,
        status:        issue.status,
        helpUrl:       issue.helpUrl,
        category:      issue.category,
        instanceCount: 0,
        instances:     [],
      });
    }
    const g = map.get(key);
    g.instanceCount += 1;
    // Promote impact if a later instance is more severe
    const order = ['critical', 'serious', 'moderate', 'minor'];
    if (order.indexOf(issue.impact) < order.indexOf(g.impact)) g.impact = issue.impact;
    // Promote status: confirmed > needs-review
    if (issue.status === 'confirmed') g.status = 'confirmed';
    g.instances.push({
      target:        issue.target,
      html:          issue.html ?? null,
      failureSummary: issue.failureSummary ?? issue.howToFix,
    });
  }
  const order = ['critical', 'serious', 'moderate', 'minor'];
  return [...map.values()].sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact));
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

// ── Custom checks (run via page.evaluate — these catch what axe misses on Webflow) ──

// 1. Color contrast — computed from actual rendered styles, not axe's static analysis.
//    axe marks color-contrast as 'incomplete' on transparent/stacked backgrounds.
//    We climb the DOM to resolve the effective background and compute the ratio ourselves.
const CUSTOM_COLOR_CONTRAST = function () {
  function getLuminance(r, g, b) {
    return [r, g, b].reduce((sum, c, i) => {
      const s = c / 255;
      const lin = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      return sum + lin * [0.2126, 0.7152, 0.0722][i];
    }, 0);
  }
  function parseRgb(color) {
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function isTransparent(color) {
    const m = color.match(/rgba\([\d\s,]+,\s*([\d.]+)\)/);
    return m ? +m[1] < 0.05 : color === 'transparent';
  }
  function effectiveBg(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (!isTransparent(bg)) {
        const rgb = parseRgb(bg);
        if (rgb) return rgb;
      }
      node = node.parentElement;
    }
    return [255, 255, 255];
  }
  function ratio(fg, bg) {
    const l1 = getLuminance(...fg) + 0.05;
    const l2 = getLuminance(...bg) + 0.05;
    return l1 > l2 ? l1 / l2 : l2 / l1;
  }

  const issues = [];
  const seen = new Set();
  const els = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, a, span, li, td, th, label, button, div');

  for (const el of els) {
    const text = el.childNodes.length &&
      Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    const fg = parseRgb(style.color);
    if (!fg) continue;
    if (isTransparent(style.color)) continue;

    const bgColor = style.backgroundColor;
    const bg = isTransparent(bgColor) ? effectiveBg(el) : (parseRgb(bgColor) || [255, 255, 255]);

    const cr = ratio(fg, bg);
    const fontSize = parseFloat(style.fontSize);
    const bold = parseInt(style.fontWeight) >= 700;
    const large = fontSize >= 18 || (bold && fontSize >= 14);
    const required = large ? 3.0 : 4.5;

    if (cr < required) {
      const key = `${el.tagName}:${style.color}:${bg.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        rule: 'color-contrast',
        impact: cr < 2.0 ? 'serious' : 'moderate',
        target: el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''),
        howToFix: `Contrast ratio ${cr.toFixed(2)}:1 — required ${required}:1 (${large ? 'large' : 'normal'} text, ${fontSize}px${bold ? ' bold' : ''})`,
        message: 'Text must have sufficient color contrast against its background',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/color-contrast',
        wcag: '1.4.3', level: 'AA', category: 'accessibility',
      });
    }
  }
  return issues;
};

// 2. Image alt — Webflow always sets alt="" so axe passes everything.
//    Flag content-sized visible images where alt="" and no ARIA compensation.
const CUSTOM_IMAGE_ALT = function () {
  const issues = [];
  for (const img of document.querySelectorAll('img')) {
    const alt = img.getAttribute('alt');
    const role = img.getAttribute('role');
    if (role === 'presentation' || role === 'none') continue;
    if (img.closest('[aria-hidden="true"]')) continue;
    if (img.getAttribute('aria-label') || img.getAttribute('aria-labelledby')) continue;
    const rect = img.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) continue;
    const style = getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (alt === null || alt.trim() === '') {
      issues.push({
        rule: 'image-alt',
        impact: 'critical',
        target: img.src ? 'img[src*="' + img.src.split('/').pop().split('?')[0].slice(0, 30) + '"]' : 'img',
        howToFix: 'Image appears content-meaningful (visible, ' + Math.round(rect.width) + '×' + Math.round(rect.height) + 'px) but has empty alt. Add a descriptive alt attribute, or role="presentation" if truly decorative.',
        message: 'Images must have alternative text',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/image-alt',
        wcag: '1.1.1', level: 'A', category: 'accessibility',
      });
    }
  }
  return issues;
};

// 3. Form labels — Webflow may add <label> elements but placeholder is often the only visible cue.
//    Detect inputs whose only accessible name source is a placeholder attribute.
const CUSTOM_FORM_LABELS = function () {
  const issues = [];
  const inputs = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select'
  );
  for (const input of inputs) {
    const style = getComputedStyle(input);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const id = input.id;
    const explicitLabel = id ? document.querySelector('label[for="' + id + '"]') : null;
    const wrappingLabel = input.closest('label');
    const ariaLabel = input.getAttribute('aria-label');
    const ariaLabelledby = input.getAttribute('aria-labelledby');
    const placeholder = input.getAttribute('placeholder');
    const name = input.name || input.id || input.type;

    const hasRealLabel = explicitLabel || wrappingLabel || ariaLabel || ariaLabelledby;

    if (!hasRealLabel && placeholder) {
      issues.push({
        rule: 'label-placeholder-only',
        impact: 'serious',
        target: input.tagName.toLowerCase() + (input.name ? '[name="' + input.name + '"]' : ''),
        howToFix: 'Field "' + placeholder + '" uses placeholder as its only label. Placeholders vanish when the user types — add a visible <label> or aria-label.',
        message: 'Form inputs must have a persistent label, not just a placeholder',
        helpUrl: 'https://www.w3.org/WAI/tutorials/forms/labels/',
        wcag: '1.3.1', level: 'A', category: 'accessibility',
      });
    } else if (!hasRealLabel && !placeholder) {
      issues.push({
        rule: 'label',
        impact: 'critical',
        target: input.tagName.toLowerCase() + (input.name ? '[name="' + name + '"]' : ''),
        howToFix: 'Form field has no label, aria-label, or placeholder. Add a <label> element.',
        message: 'Form inputs must have an associated label',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/label',
        wcag: '1.3.1', level: 'A', category: 'accessibility',
      });
    }
  }
  return issues;
};

// 4. Generic link text — axe's link-name only catches *empty* link text, not vague text.
const CUSTOM_LINK_TEXT = function () {
  const GENERIC = /^(click here|click|here|read more|learn more|more|details|link|this|tap|go|view|see more|continue|download|submit|visit|open|start|get started|find out more|find out|see details)$/i;
  const issues = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const style = getComputedStyle(a);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const text = (a.textContent || '').trim();
    const ariaLabel = a.getAttribute('aria-label');
    const title = a.getAttribute('title');
    if (ariaLabel || title) continue;
    if (GENERIC.test(text)) {
      const key = text.toLowerCase() + ':' + a.href;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        rule: 'link-name-generic',
        impact: 'moderate',
        target: 'a[href="' + (a.getAttribute('href') || '').slice(0, 60) + '"]',
        howToFix: 'Link text "' + text + '" doesn\'t describe its destination. Use descriptive text like "Download annual report" instead.',
        message: 'Links must have descriptive text that explains their purpose',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/link-name',
        wcag: '2.4.4', level: 'A', category: 'accessibility',
      });
    }
  }
  return issues;
};

// 5. Button accessible name — axe catches empty buttons, but Webflow icon buttons often
//    have a whitespace text node or a hidden child span that axe counts as a valid name.
const CUSTOM_BUTTON_NAME = function () {
  const issues = [];
  const seen = new Set();
  for (const btn of document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')) {
    const style = getComputedStyle(btn);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const ariaLabel = btn.getAttribute('aria-label');
    const ariaLabelledby = btn.getAttribute('aria-labelledby');
    const title = btn.getAttribute('title');
    const value = btn.getAttribute('value');
    if (ariaLabel || ariaLabelledby || title || value) continue;

    // Check if visible text exists (not just whitespace or hidden spans)
    let visibleText = '';
    for (const node of btn.childNodes) {
      if (node.nodeType === 3) visibleText += node.textContent;
      else if (node.nodeType === 1) {
        const cs = getComputedStyle(node);
        if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.position !== 'absolute') {
          visibleText += node.textContent;
        }
      }
    }
    visibleText = visibleText.trim();

    // Only flag if visually text-less (likely icon-only button)
    const hasOnlyIcons = btn.querySelectorAll('svg, img, i').length > 0 && !visibleText;
    if (hasOnlyIcons) {
      const key = btn.className + ':' + (btn.textContent || '').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        rule: 'button-name',
        impact: 'critical',
        target: btn.tagName.toLowerCase() + (btn.className ? '.' + btn.className.trim().split(/\s+/)[0] : ''),
        howToFix: 'Button contains only an icon with no accessible name. Add aria-label="[action]" to describe what it does.',
        message: 'Buttons must have an accessible name',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/button-name',
        wcag: '4.1.2', level: 'A', category: 'accessibility',
      });
    }
  }
  return issues;
};

// 6. Heading order — axe catches this but only as best-practice. Promote skipped levels
//    and multiple H1s to accessibility violations since they break screen reader navigation.
const CUSTOM_HEADING_ORDER = function () {
  const issues = [];
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(h => {
    const s = getComputedStyle(h);
    return s.display !== 'none' && s.visibility !== 'hidden';
  });

  // Multiple H1s
  const h1s = headings.filter(h => h.tagName === 'H1');
  if (h1s.length > 1) {
    for (const h1 of h1s.slice(1)) {
      issues.push({
        rule: 'page-has-one-main-heading',
        impact: 'moderate',
        target: 'h1',
        howToFix: 'Page has ' + h1s.length + ' H1 elements. Only one H1 should exist per page — it defines the main topic.',
        message: 'Page should have only one H1 heading',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/page-has-heading-one',
        wcag: '1.3.1', level: 'A', category: 'accessibility',
      });
      break;
    }
  }

  // Skipped levels
  let prevLevel = 0;
  for (const h of headings) {
    const level = parseInt(h.tagName[1]);
    if (prevLevel > 0 && level > prevLevel + 1) {
      issues.push({
        rule: 'heading-order',
        impact: 'moderate',
        target: h.tagName.toLowerCase(),
        howToFix: 'Heading jumps from H' + prevLevel + ' to H' + level + '. Heading levels must not be skipped (use H' + (prevLevel + 1) + ' next).',
        message: 'Heading levels should not be skipped',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/heading-order',
        wcag: '1.3.1', level: 'A', category: 'accessibility',
      });
    }
    prevLevel = level;
  }
  return issues;
};

// 7. Table accessibility — missing <th>, missing scope, layout tables without role="presentation"
const CUSTOM_TABLE_CHECKS = function () {
  const issues = [];
  for (const table of document.querySelectorAll('table')) {
    const style = getComputedStyle(table);
    if (style.display === 'none') continue;
    const role = table.getAttribute('role');
    const hasHeaders = table.querySelectorAll('th').length > 0;
    const hasCaption = table.querySelector('caption');
    const rows = table.querySelectorAll('tr');
    const isDataTable = hasHeaders || (rows.length > 1 && table.querySelectorAll('td').length > 2);

    if (!isDataTable) continue; // skip tiny or layout tables

    if (!hasHeaders) {
      issues.push({
        rule: 'td-headers-attr',
        impact: 'serious',
        target: 'table',
        howToFix: 'Data table has no <th> header cells. Add <th> elements in the first row or column to identify column/row headers.',
        message: 'Data tables must have header cells',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/td-headers-attr',
        wcag: '1.3.1', level: 'A', category: 'accessibility',
      });
    }

    if (!hasCaption && isDataTable) {
      issues.push({
        rule: 'table-no-caption',
        impact: 'minor',
        target: 'table',
        howToFix: 'Data table has no <caption>. Add a <caption> element to give the table a title screen readers announce before reading the data.',
        message: 'Data tables should have a caption',
        helpUrl: 'https://www.w3.org/WAI/tutorials/tables/caption-summary/',
        wcag: '1.3.1', level: 'A', category: 'best-practice',
      });
    }

    // Check th elements have scope
    for (const th of table.querySelectorAll('th')) {
      if (!th.getAttribute('scope') && !th.getAttribute('id')) {
        issues.push({
          rule: 'th-has-data-cells',
          impact: 'serious',
          target: 'th',
          howToFix: 'Header cell <th> has no scope attribute. Add scope="col" or scope="row" so assistive tech knows which cells it applies to.',
          message: 'Table header cells must have a scope attribute',
          helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/th-has-data-cells',
          wcag: '1.3.1', level: 'A', category: 'accessibility',
        });
        break; // one issue per table
      }
    }
  }
  return issues;
};

// 8. Focus indicators — detect interactive elements whose :focus outline/outline-width
//    resolves to 0 or none (common when sites do outline: none globally).
const CUSTOM_FOCUS_INDICATORS = function () {
  const issues = [];
  const interactive = document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
  const seen = new Set();

  for (const el of interactive) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Temporarily force focus state to read focus styles — not possible without actual focus.
    // Instead: check if outline is suppressed globally (outline: 0 or outline: none)
    // and no box-shadow or border changes on :focus are present.
    // We use a heuristic: inject a temporary style and measure.
    const outlineWidth = style.outlineWidth;
    const outlineStyle = style.outlineStyle;
    const isSuppressed = outlineStyle === 'none' || parseFloat(outlineWidth) === 0;

    if (isSuppressed) {
      const tag = el.tagName.toLowerCase();
      const key = tag + ':' + (el.className || '').trim().split(/\s+/)[0];
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        rule: 'focus-visible',
        impact: 'serious',
        target: tag + (el.id ? '#' + el.id : el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''),
        howToFix: 'Interactive element has outline suppressed (outline:none or outline-width:0). Keyboard users cannot see focus. Add a :focus-visible style with outline, box-shadow, or border change.',
        message: 'Interactive elements must have a visible focus indicator',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/focus-visible',
        wcag: '2.4.7', level: 'AA', category: 'accessibility',
      });
    }
  }
  return issues;
};

// 9. Click handlers on non-interactive elements — divs/spans with onclick but no role or tabindex.
const CUSTOM_CLICK_HANDLERS = function () {
  const issues = [];
  const seen = new Set();
  // We can't read event listeners directly, but Webflow embeds onclick attributes
  // or uses data attributes that signal interactive intent.
  const candidates = document.querySelectorAll('[onclick], [data-w-id]');
  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'label'].includes(tag)) continue;
    const role = el.getAttribute('role');
    const tabindex = el.getAttribute('tabindex');
    const isKeyboardReachable = tabindex !== null && tabindex !== '-1';
    const hasRole = role && ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option', 'switch'].includes(role);
    if (!isKeyboardReachable || !hasRole) {
      const key = tag + ':' + (el.className || '').trim().split(/\s+/)[0];
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        rule: 'non-interactive-element-has-role',
        impact: el.getAttribute('onclick') ? 'serious' : 'moderate',
        target: tag + (el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''),
        howToFix: !hasRole
          ? 'Element <' + tag + '> has a click handler but no ARIA role. Add role="button" (or appropriate role) and tabindex="0" so keyboard users can reach and activate it.'
          : 'Element <' + tag + '> has role="' + role + '" but tabindex is missing or -1. Add tabindex="0" to make it keyboard-reachable.',
        message: 'Non-interactive elements with click handlers must have role and tabindex',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/keyboard',
        wcag: '2.1.1', level: 'A', category: 'accessibility',
      });
    }
  }
  return issues;
};

// 10. Meta-viewport: detect user-scalable=no or maximum-scale=1 on the rendered meta tag
const CUSTOM_META_VIEWPORT = function () {
  const issues = [];
  const vm = document.querySelector('meta[name="viewport"]');
  if (!vm) return issues;
  const content = vm.getAttribute('content') || '';
  const hasScaleLock =
    /user-scalable\s*=\s*(no|0)/i.test(content) ||
    /maximum-scale\s*=\s*1(\s*[^.0-9]|$)/i.test(content);
  if (hasScaleLock) {
    issues.push({
      rule: 'meta-viewport',
      impact: 'critical',
      wcag: '1.4.4',
      level: 'AA',
      target: 'meta[name="viewport"]',
      howToFix: 'The viewport meta tag disables user scaling (' + content + '). Remove user-scalable=no and maximum-scale=1 so users can zoom up to 200%.',
      message: 'Viewport meta must not block user scaling (WCAG 1.4.4)',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/meta-viewport',
      category: 'accessibility',
    });
  }
  return issues;
};

// 11. Autocomplete-valid: inputs that SHOULD have autocomplete but are missing it entirely
const CUSTOM_AUTOCOMPLETE = function () {
  const SHOULD_HAVE = {
    email: 'email',
    tel: 'tel',
  };
  const NAME_MAP = {
    name: 'name', fullname: 'name', fname: 'given-name', lname: 'family-name',
    firstname: 'given-name', lastname: 'family-name',
    email: 'email',
    address: 'street-address', city: 'address-level2', zip: 'postal-code',
    phone: 'tel', mobile: 'tel',
  };
  const issues = [];
  const inputs = document.querySelectorAll('input');
  for (const input of inputs) {
    const style = getComputedStyle(input);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const type = (input.type || '').toLowerCase();
    const name = (input.name || input.id || '').toLowerCase();
    const existing = input.getAttribute('autocomplete');
    if (existing && existing !== 'off') continue; // already has autocomplete or is off intentionally
    let expectedToken = SHOULD_HAVE[type];
    if (!expectedToken) {
      for (const [key, token] of Object.entries(NAME_MAP)) {
        if (name.includes(key)) { expectedToken = token; break; }
      }
    }
    if (expectedToken) {
      issues.push({
        rule: 'autocomplete-valid',
        impact: 'serious',
        wcag: '1.3.5',
        level: 'AA',
        target: 'input[type="' + type + '"]' + (input.name ? '[name="' + input.name + '"]' : ''),
        howToFix: 'Input is missing autocomplete attribute. Add autocomplete="' + expectedToken + '" so browsers and password managers can assist users.',
        message: 'Input for personal data must have an appropriate autocomplete attribute (WCAG 1.3.5)',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/autocomplete-valid',
        category: 'accessibility',
      });
    }
  }
  return issues;
};

// 12. Bypass / skip link: page should have a skip-to-main link before the first interactive element
const CUSTOM_BYPASS = function () {
  const issues = [];
  const hasMain = document.querySelector('main, [role="main"], #main, #content, #main-content');
  const links = Array.from(document.querySelectorAll('a[href]'));
  const interactiveCount = document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea').length;
  if (interactiveCount < 4) return issues; // not enough navigation to need skip link

  const skipLink = links.find(a => {
    const href = a.getAttribute('href') || '';
    return href.startsWith('#') && (
      /skip|main|content|nav/i.test(href) ||
      /skip|jump|bypass/i.test((a.textContent || '').trim())
    );
  });

  if (!skipLink) {
    issues.push({
      rule: 'bypass',
      impact: 'serious',
      wcag: '2.4.1',
      level: 'A',
      target: 'body',
      howToFix: 'Page has no skip navigation link. Add <a href="#main-content" class="skip-link">Skip to main content</a> as the first focusable element, and a matching id on the main content area.',
      message: 'Page must have a mechanism to bypass repeated navigation blocks (WCAG 2.4.1)',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/bypass',
      category: 'accessibility',
    });
  }
  return issues;
};

// 13. Label-content-name mismatch: visible button/link text not contained in its accessible name
const CUSTOM_LABEL_NAME_MISMATCH = function () {
  const issues = [];
  const els = document.querySelectorAll('button[aria-label], a[aria-label], [role="button"][aria-label]');
  for (const el of els) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    const visibleText = (el.textContent || '').toLowerCase().trim();
    if (!visibleText) continue; // no visible text, not a mismatch
    // accessible name must CONTAIN the visible text
    if (ariaLabel && !ariaLabel.includes(visibleText)) {
      issues.push({
        rule: 'label-content-name-mismatch',
        impact: 'serious',
        wcag: '2.5.3',
        level: 'A',
        target: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
        howToFix: 'Visible label "' + visibleText + '" is not contained in the accessible name "' + ariaLabel + '". Speech input users say the visible text — the accessible name must include it.',
        message: 'Accessible name must contain the visible label text (WCAG 2.5.3)',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/label-content-name-mismatch',
        category: 'accessibility',
      });
    }
  }
  return issues;
};

// 14. Error fields missing aria-invalid: inputs with visible error styling but no aria-invalid
const CUSTOM_ARIA_INVALID = function () {
  const issues = [];
  const inputs = document.querySelectorAll('input, textarea, select');
  for (const input of inputs) {
    const style = getComputedStyle(input);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const hasAriaInvalid = input.hasAttribute('aria-invalid');
    if (hasAriaInvalid) continue;
    // Detect error styling heuristic: red/orange border or border color
    const borderColor = style.borderColor;
    const isErrorColored = /rgb\(255,\s*0,\s*0\)|rgb\(220,\s*53,\s*69\)|rgb\(239,\s*68,\s*68\)|rgb\(220,\s*38,\s*38\)/i.test(borderColor);
    // Also check for nearby error message element
    const parent = input.parentElement;
    const nextSib = input.nextElementSibling;
    const hasErrorMsg = (nextSib && /error|invalid|required/i.test(nextSib.textContent)) ||
      (parent && parent.querySelector('[class*="error" i], [class*="invalid" i]'));
    if (isErrorColored || hasErrorMsg) {
      issues.push({
        rule: 'aria-invalid-on-error',
        impact: 'serious',
        wcag: '3.3.1',
        level: 'A',
        target: input.tagName.toLowerCase() + (input.name ? '[name="' + input.name + '"]' : ''),
        howToFix: 'Input appears to be in an error state (red border or adjacent error message) but is missing aria-invalid="true". Add aria-invalid="true" and aria-describedby pointing to the error message.',
        message: 'Input in error state must have aria-invalid="true" (WCAG 3.3.1)',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/error-identification.html',
        category: 'accessibility',
      });
    }
  }
  return issues;
};

// 15. Paste blocking: inputs with onpaste that calls preventDefault (3.3.8)
const CUSTOM_PASTE_BLOCKING = function () {
  const issues = [];
  const inputs = document.querySelectorAll('input[onpaste], textarea[onpaste]');
  for (const input of inputs) {
    const style = getComputedStyle(input);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const handler = (input.getAttribute('onpaste') || '').toLowerCase();
    if (handler.includes('preventdefault') || handler.includes('return false')) {
      issues.push({
        rule: 'paste-not-blocked',
        impact: 'moderate',
        wcag: '3.3.8',
        level: 'AA',
        target: input.tagName.toLowerCase() + (input.type ? '[type="' + input.type + '"]' : '') + (input.name ? '[name="' + input.name + '"]' : ''),
        howToFix: 'This field blocks paste via onpaste handler. Blocking paste forces users (especially those with disabilities) to type manually. Remove the paste restriction (WCAG 3.3.8).',
        message: 'Inputs must not block paste for authentication or sensitive fields (WCAG 3.3.8)',
        helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html',
        category: 'accessibility',
      });
    }
  }
  return issues;
};

// Run all custom checks in a single page.evaluate call and return merged issues.
async function runCustomChecks(page) {
  const raw = await page.evaluate(([
    contrast, imageAlt, formLabels, linkText,
    buttonName, headingOrder, tableChecks,
    focusIndicators, clickHandlers,
    metaViewport, autocomplete, bypass,
    labelNameMismatch, ariaInvalid, pasteBlocking,
  ]) => {
    /* eslint-disable no-new-func */
    const run = fn => { try { return new Function('return (' + fn + ')')()(); } catch { return []; } };
    return [
      ...run(contrast),
      ...run(imageAlt),
      ...run(formLabels),
      ...run(linkText),
      ...run(buttonName),
      ...run(headingOrder),
      ...run(tableChecks),
      ...run(focusIndicators),
      ...run(clickHandlers),
      ...run(metaViewport),
      ...run(autocomplete),
      ...run(bypass),
      ...run(labelNameMismatch),
      ...run(ariaInvalid),
      ...run(pasteBlocking),
    ];
  }, [
    CUSTOM_COLOR_CONTRAST.toString(),
    CUSTOM_IMAGE_ALT.toString(),
    CUSTOM_FORM_LABELS.toString(),
    CUSTOM_LINK_TEXT.toString(),
    CUSTOM_BUTTON_NAME.toString(),
    CUSTOM_HEADING_ORDER.toString(),
    CUSTOM_TABLE_CHECKS.toString(),
    CUSTOM_FOCUS_INDICATORS.toString(),
    CUSTOM_CLICK_HANDLERS.toString(),
    CUSTOM_META_VIEWPORT.toString(),
    CUSTOM_AUTOCOMPLETE.toString(),
    CUSTOM_BYPASS.toString(),
    CUSTOM_LABEL_NAME_MISMATCH.toString(),
    CUSTOM_ARIA_INVALID.toString(),
    CUSTOM_PASTE_BLOCKING.toString(),
  ]);
  // Tag all custom DOM check issues as confirmed
  return raw.map(i => ({ ...i, status: i.status ?? 'confirmed' }));
}

// Runtime checks that require Puppeteer-level interaction (keyboard, viewport, media).
async function runRuntimeChecks(page) {
  const issues = [];

  // 1. Reflow check (WCAG 1.4.10): page must not scroll horizontally at 320px width
  try {
    const originalViewport = await page.viewport();
    await page.setViewport({ width: 320, height: 480 });
    const hasHorizScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    await page.setViewport(originalViewport || { width: 1280, height: 800 });
    if (hasHorizScroll) {
      issues.push({
        rule:     'reflow',
        impact:   'serious',
        wcag:     '1.4.10',
        level:    'AA',
        target:   'html',
        howToFix: 'Page requires horizontal scrolling at 320px viewport width. Avoid fixed widths; use CSS flexbox/grid with responsive units so content reflows into a single column.',
        message:  'Content must reflow at 320px without horizontal scroll (WCAG 1.4.10)',
        helpUrl:  'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html',
        category: 'accessibility',
        status:   'confirmed',
      });
    }
  } catch {}

  // 2. Autoplay media check (WCAG 2.2.2): flag <video autoplay> without controls
  try {
    const autoplayIssues = await page.evaluate(() => {
      const results = [];
      const videos = document.querySelectorAll('video[autoplay]');
      for (const v of videos) {
        if (v.hasAttribute('controls')) continue;
        // Check for a nearby pause/stop button heuristic
        const parent = v.parentElement;
        const hasPauseBtn = parent &&
          parent.querySelector('[aria-label*="pause" i], [aria-label*="stop" i], [title*="pause" i]');
        if (!hasPauseBtn) {
          results.push({
            rule:     'no-autoplay',
            impact:   'moderate',
            wcag:     '2.2.2',
            level:    'A',
            target:   'video[autoplay]',
            howToFix: 'Video autoplays without controls or a visible pause button. Add the controls attribute or provide a mechanism to pause or stop the video.',
            message:  'Autoplay video must have controls or a pause mechanism (WCAG 2.2.2)',
            helpUrl:  'https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide.html',
            category: 'accessibility',
            status:   'confirmed',
          });
          break; // one issue per page is enough
        }
      }
      return results;
    });
    issues.push(...autoplayIssues);
  } catch {}

  return issues;
}

function buildSummary(issues, passes, incomplete) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  // Per-rule worst impact (for rule-weighted scoring)
  const worstImpact = new Map();

  for (const i of issues) {
    counts[i.impact] = (counts[i.impact] ?? 0) + 1;
    const order = ['critical', 'serious', 'moderate', 'minor'];
    const prev = worstImpact.get(i.rule);
    if (!prev || order.indexOf(i.impact) < order.indexOf(prev)) {
      worstImpact.set(i.rule, i.impact);
    }
  }

  const accessibilityIssues = issues.filter(i => i.category === 'accessibility' || i.category === 'needs-review');
  const bestPracticeIssues = issues.filter(i => i.category === 'best-practice');

  // Rule-weighted scoring:
  // Each unique failing rule costs: Critical=10, Serious=7, Moderate=3, Minor=1
  // Plus a small log bonus per extra instance so repeating components don't
  // catastrophically zero the score (log2(instanceCount + 1) * 0.5, capped at 3).
  const RULE_WEIGHTS = { critical: 10, serious: 7, moderate: 3, minor: 1 };
  // Count instances per rule
  const instancesPerRule = new Map();
  for (const i of issues) {
    instancesPerRule.set(i.rule, (instancesPerRule.get(i.rule) ?? 0) + 1);
  }
  let deduction = 0;
  for (const [rule, impact] of worstImpact) {
    const base = RULE_WEIGHTS[impact] ?? 1;
    const n    = instancesPerRule.get(rule) ?? 1;
    const instanceBonus = Math.min(3, Math.log2(n + 1) * 0.5);
    deduction += base + instanceBonus;
  }
  const score = Math.max(0, Math.round(100 - deduction));

  return {
    total: issues.length,
    accessibility: accessibilityIssues.length,
    bestPractice: bestPracticeIssues.length,
    byCritical: counts.critical,
    bySerious: counts.serious,
    byModerate: counts.moderate,
    byMinor: counts.minor,
    uniqueRules: worstImpact.size,
    passedRules: passes.length,
    incompleteRules: incomplete.length,
    score,
    customChecks: true,
  };
}
