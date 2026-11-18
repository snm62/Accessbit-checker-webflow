# Accessibility Checker for Webflow — Market-Readiness Plan

Date: 2026-11-09
Scope: full audit of the current app (Designer Extension + Cloudflare Worker backend) and the plan to take it to a commercial, Webflow-Marketplace-approved product that scans every page of the installed site.

Verdict today: **DO NOT SUBMIT / DO NOT SELL YET.** The backend has three authentication bypasses that let anyone who knows a site ID (printed in every published Webflow page as `data-wf-site`) obtain a session, run scans against that site's quota and read its scan history. The "only the installed site" rule is not enforced for custom domains. These are fixable in days, and the rest of the plan is ordinary product work.

---

## 1. What exists today (architecture snapshot)

| Layer | Tech | Files |
|---|---|---|
| Designer Extension (UI) | React 18, TypeScript, webpack, unminified | `src/app.tsx`, `src/components/*`, `src/hooks/useAuth.ts` |
| Backend | Cloudflare Worker, KV (`TOKENS`), Browser Rendering (`MY_BROWSER`) | `src/worker.js`, `src/auth/*`, `src/scanner.js` |
| Scan engine | Puppeteer + axe-core 4.10.2 loaded from cdnjs at scan time | `src/scanner.js` |
| Auth | Webflow OAuth (`sites:read pages:read authorized_user:read`) → access token in KV → HS256 session JWT (1 h) | `src/auth/oauth.js`, `src/auth/jwt.js`, `src/auth/designerToken.js` |
| Storage | KV: `scanner:auth:<siteId>`, `scanner:scan:<id>` (30 d), `scanner:history:<siteId>` (last 20), `scanner:ratelimit:<siteId>:<day>` | `src/worker.js` |

Current capability: one URL at a time, single page, WCAG 2.1 A/AA + best-practice via axe, 20 scans/site/day, history of 20 scans.

What the user asked for and the app does not do yet: pick the site's domain and scan **every page** of that Webflow site.

---

## 2. Findings — ranked most severe first

Severity key: **P0** = exploitable now, fix before anything else. **P1** = will fail Marketplace review or breaks the product promise. **P2** = needed for a commercial product. **P3** = quality / differentiation.

### P0 — Security (exploitable today)

| # | Finding | Where | Fix |
|---|---|---|---|
| S1 | **`POST /api/scanner/auth/token` issues a session JWT to anyone who sends a `siteId`.** No proof of identity at all. Site IDs are public. | `src/auth/oauth.js` `handleToken` | Delete the endpoint. The extension never calls it (it uses `designer-token`). |
| S2 | **Designer ID token is decoded, never verified.** If decoding fails the code "proceeds — the KV check is the real gate". `{"siteId":"<public id>","idToken":"x.e30.x"}` returns a valid session. | `src/auth/designerToken.js` | Call Webflow's **Resolve ID Token** endpoint (`POST https://api.webflow.com/beta/token/resolve`, body `{ idToken }`, bearer = stored access token for that site). Use the returned user `id`/`email`; reject on any non-200. Never fall through on decode failure. |
| S3 | **OAuth `state` is never verified server-side.** `handleAuthorize` only checks that a `state` exists; `handleCallback` ignores it; the extension never compares it either. This is the CSRF control Webflow review tests as pass/fail for Data Client / Hybrid apps. | `src/auth/oauth.js` | Server mints a random single-use `state`, stores it in KV with 10 min TTL bound to a `HttpOnly; Secure; SameSite=None` cookie; callback verifies **and consumes** it in one step before exchanging the code. Reject missing / mismatched / expired / reused. Use this same endpoint as the Marketplace **Install URL**. |
| S4 | **Session token is sent via `postMessage(..., '*')`.** A wildcard target carrying a credential is a Preflight **Blocker**. | `src/auth/oauth.js` `popupPage` | Stop sending the token through the popup at all. Post only `{ type: 'AUTH_COMPLETE' }`; the extension then calls `designer-token` (S2) to get its session. |
| S5 | **Domain lock is not a lock.** Any hostname whose CNAME chain ends in `*.webflow.com` passes, i.e. *every Webflow-hosted site on the internet*. Apex domains (A records) fail even when they are the user's own. `*.webflow.io` passes for any site if `shortName` is empty. `allowedDomains` is computed but never read, and it is built from `/v2/sites/{id}/domains`, which is not a v2 endpoint, so custom domains are always empty. | `src/worker.js` `validateDomainOwnership`, `src/auth/oauth.js` | Build the allowlist from Webflow only: `<shortName>.webflow.io` + `GET /v2/sites/{site_id}/custom_domains` (`customDomains[].url`). Cache per site (1 h), refresh on 403. Compare `hostname` exactly against the list (and accept `www.` ↔ apex only if both are in the list). Drop the DNS heuristic entirely. |
| S6 | **OAuth callback stores the token under `sites[0]`**, not the site the user is working in. In a multi-site workspace the wrong site gets authorised, the right one never does, and one user's token can overwrite another's record for a shared site. | `src/auth/oauth.js` `handleCallback` | Pass the Designer `siteId` through `state` (server-side, not in the URL), then after exchange store the token for **every** site returned by `/v2/sites` (that is what the user granted) keyed `auth:<siteId>`, plus `user:<userId>`. Resolve "which site" from the Designer ID token on every request, never from the client body. |
| S7 | Callback error page echoes the raw token-exchange response body and the redirect URI to the browser. | `src/auth/oauth.js` | Generic message to the user; detail to logs only. |
| S8 | **CORS allows `http://localhost*` and `http://127.0.0.1*` in production**, and sets `Allow-Credentials: true` with no cookie use. | `src/worker.js` | Allow only `https://*.webflow-ext.com`, `https://webflow.com`, `https://*.webflow.com`; localhost only when `env.ENVIRONMENT === 'development'`. Remove `Allow-Credentials`. Remember CORS is not authorisation; S1–S3 are. |
| S9 | Webflow access tokens stored **plaintext** in KV. | KV `scanner:auth:*` | Encrypt with AES-GCM using a `TOKEN_ENC_KEY` secret before `put`; decrypt only in the Worker. Rotate on key compromise. |
| S10 | Dead legacy OAuth module posts the **raw Webflow access token** to `window.opener` with `'*'`. Not wired today, but one import away from disaster and visible to reviewers. | `src/oauth.js` | Delete the file. |
| S11 | Rate limit is a KV read-then-write (racy; parallel requests bypass it) and auth endpoints are unlimited, so an attacker can make the Worker hammer Webflow's API with your client credentials. | `src/worker.js` `checkRateLimit`, auth routes | Use the Workers **Rate Limiting binding** or a Durable Object counter for per-site and per-IP limits on every route, including `designer-token` and the OAuth endpoints. |
| S12 | 5xx error messages are returned verbatim (`err.message`) to the client. | `src/worker.js` catch block | Return a generic message for status ≥ 500 with a request ID; log the detail. |
| S13 | Login redirect detection uses `finalUrl.includes(hostname)` (substring match, bypassable) and regexes like `/auth/i` that false-positive on `/authors`. | `src/scanner.js` | Compare `new URL(finalUrl).hostname` to the allowlist; detect Webflow password pages by the form posting to `/.wf_auth` instead of URL words. |
| S14 | Worker serves `public/index.html` at `/` but not `bundle.js`, so the root URL is a broken half-page. The extension is served by Webflow, not by the Worker. | `src/worker.js` | Remove the route and the `INDEX_HTML` import; return 404 or redirect to the marketing site. |

### P1 — Webflow Marketplace review blockers

| # | Finding | Fix |
|---|---|---|
| R1 | `bundle.zip` contains `bundle.js.map` and `bundle.css.map`. Preflight: **Required update** (`SRC-MAP-PUBLIC-EXPOSURE`). | Emit maps to a separate folder (`devtool: 'source-map'`, `output.sourceMapFilename: '../maps/[file].map'`) and remove the `sourceMappingURL` comment from the shipped bundle. Upload the maps in the submission form's private field. |
| R2 | Bundled `webflow.json` carries the CLI `telemetry.global` block. | Strip it from the bundled manifest (or upgrade the Webflow CLI). |
| R3 | Install path is not an Install URL you own (see S3). | `GET https://<api-domain>/oauth/install` mints state and redirects; declare it as the Marketplace Install URL. |
| R4 | `localStorage` is used to flip `isAuthenticated = true` before any token exists, and the stored `siteId` can differ from the site currently open in the Designer. | Treat `localStorage` as UI cache only. Source of truth for the site is `webflow.getSiteInfo()` on every load; the session comes from `designer-token`. If stored `siteId !== current siteId`, discard the cache. |
| R5 | External stylesheet from Google Fonts in `public/index.html`. External connections are a reviewer confirmation item, and the Designer's CSP may block it. | Self-host the Archivo woff2 files in the bundle (webpack `asset/inline` is already configured) or use system fonts. |
| R6 | Hard-coded `*.workers.dev` API host in the bundle (`src/util/constants.ts`). Acceptable, but reads as non-production and ties you to a Cloudflare subdomain forever. | Put the Worker on a custom domain (`api.<yourbrand>.com`) via Cloudflare Routes; keep workers.dev as fallback only. |
| R7 | No privacy policy, terms of service, support contact or in-app data disclosure. All required for listing. | See §5. |
| R8 | Listing assets, demo `.webflow.io` site, 2–5 min demo video showing OAuth **approve and deny**, 512×512 icon, 3–5 screenshots at 1280×846, 2FA on the workspace admin account. | Produce before submission. |
| R9 | Misleading success copy: "This page passes all WCAG 2.1 A/AA checks." Automated testing covers roughly a third to a half of WCAG criteria. Review (and the FTC, see §5) treat compliance claims seriously. | Change to "No issues detected by automated checks" and keep the existing manual-testing disclaimer visible on every results view and export. |
| R10 | Interactive `div`s (`issue-card`, history rows) have no `role`, no `tabIndex`, no keyboard handler; secondary text at `rgba(255,255,255,0.35–0.45)` on `#0A081B` is roughly 3:1, below the 4.5:1 WCAG AA minimum. An accessibility checker that fails its own audit will be noticed. | Make cards `<button>` elements; raise secondary text to ≥ 0.6 alpha; run axe on the extension itself in CI. |
| R11 | No `.map`-free production verification step; `optimization.minimize: false` is fine (readable source is a plus) but there is no build rule that fails on dev/staging/localhost request destinations. | Add a `postbuild` script that greps the bundle for `localhost`, `127.0.0.1`, `ngrok`, `workers.dev` (once R6 is done) and fails the build. |

Scope check (positive): the app injects **no custom code** into customer sites, so the Custom Code API cleanup rules do not apply. The three scopes requested are the minimum for today's behaviour. Adding whole-site CMS sampling (§3) will add `cms:read`; nothing else.

### P2 — Product: the whole-site scan the user asked for

See §3 for the design. Gaps today: no page discovery, no job model (one request = one browser = one page), no progress reporting, KV-only storage (25 MB value cap, eventual consistency), no site-wide issue de-duplication, no export.

### P2 — Commercial readiness

| # | Gap | Fix |
|---|---|---|
| C1 | No billing or entitlements; hard-coded 20 scans/day. | Stripe Checkout + Customer Portal; entitlement record per **workspace or site** in D1; plan limits enforced server-side (`plan.maxPagesPerScan`, `plan.scansPerMonth`, `plan.scheduledScans`). Webflow does not process payments for apps; fees must be disclosed in the listing. |
| C2 | No revocation handling. A persistent 401 from Webflow on a previously valid token is uninstall/revocation. | On 401 from `/v2/token/authorized_by` or any Data API call: delete `auth:<siteId>`, cancel schedules, purge that site's scan data after a grace period (e.g. 30 days) and never retry. |
| C3 | No user-initiated data deletion. | "Disconnect and delete my data" in the app → revoke at `https://api.webflow.com/oauth/revoke_authorization`, purge all keys for that site/user. |
| C4 | Observability off (`observability.logs.enabled = false`), no alerts, no uptime check, no status page. | Enable Workers logs with PII redaction, add Sentry (or Workers Analytics Engine) for errors, an external uptime monitor on `/health`, and a public status page. Reviewers test the backend for 10–15 business days; it must stay up. |
| C5 | No tests. | Vitest + `@cloudflare/vitest-pool-workers`: unit tests for auth (S1–S6 regression), object-level authorisation (site A cannot read site B's scan), allowlist logic, axe result processing; one Playwright smoke test against the demo site. |
| C6 | Secrets handling: `.dev.vars` is git-ignored (good); `wrangler.toml` documents `wrangler secret put` (good). No rotation procedure, no separate staging Worker. | Add `[env.staging]` and `[env.production]` in `wrangler.toml` with separate KV/D1 and secrets; document rotation of `WORKER_JWT_SECRET`, `WEBFLOW_CLIENT_SECRET`, `TOKEN_ENC_KEY`. |
| C7 | Dependencies: `wrangler` 3.x (4.x is current), `@cloudflare/puppeteer` 1.x. `npm audit` is clean today. | Upgrade wrangler; add Dependabot/Renovate; keep `npm audit` in CI. |
| C8 | Scoring formula (100 − 10·critical − 5·serious − 2·moderate − 1·minor) is undocumented and can hit 0 on a long page with many minor issues. | Keep it, but normalise per unique rule + document it in-app ("Score is a relative indicator, not a compliance measure"). |

### P3 — Quality and differentiation

- Add WCAG 2.2 tags (`wcag22a`, `wcag22aa`) to axe `runOnly`; axe 4.10 supports them. Market "WCAG 2.2 AA" (EAA came into force June 2025; many buyers search for it).
- Bundle axe-core into the Worker and inject with `addScriptTag({ content })` instead of fetching from cdnjs at scan time: deterministic version, no third-party runtime dependency, works if the CDN is down, and reviewers can see exactly what runs.
- Identify the crawler: `page.setUserAgent('AccessibilityChecker/1.0 (+https://<yourbrand>/bot)')` and add `X-Accessibility-Scan: 1` so site owners can filter analytics (the tracker blocklist helps but is not complete).
- Block navigation/redirects to private IP ranges and non-http(s) schemes inside the browser (defence in depth against SSRF-style redirects).
- "Jump to element in Designer": map axe `target` selectors to Designer elements via `webflow.getAllElements()` + class/text matching. Hard, high value; phase 4.
- Colour-contrast fix suggestions with the exact passing colour; alt-text drafting; PDF/CSV export with the disclaimer baked in; Slack/email digest for scheduled scans.

---

## 3. Whole-site scanning — design

### 3.1 Domain selection (replaces free-text URL)

The user should not type arbitrary URLs. On the scanner screen show a **domain dropdown** populated server-side from the allowlist in S5:

1. `<shortName>.webflow.io` (staging, always present)
2. each `customDomains[].url` from `GET /v2/sites/{site_id}/custom_domains`

Keep an "advanced: single page URL" field that still validates against the same allowlist. Anything off-list is rejected with 403 before a browser is launched.

### 3.2 Page discovery (Webflow API first, crawl second)

```
GET /v2/sites/{site_id}/pages?limit=100&offset=N      (scope: pages:read)
```

- Skip pages where `draft === true` or `archived === true`.
- Static pages: URL = `https://<domain>` + `publishedPath` (fall back to building from `slug` + parent folder chain via `parentId`).
- CMS template pages (`collectionId` set): fetch `GET /v2/collections/{collectionId}/items?limit=N` (scope `cms:read`) and scan a **sample** of N live items per collection (plan-dependent: 3 / 10 / all). Template pages share one layout, so sampling finds the template-level issues cheaply.
- Password-protected pages: detect at scan time (form posting to `/.wf_auth`) and report as "skipped — password protected" instead of failing.
- Locales: if the site has secondary locales, offer "scan all locales" (`?localeId=`), default off.
- **Optional link crawl** (same host only, max depth 2, max N URLs) to catch pages the API missed and to surface 404s. Normalise URLs (strip `#`, UTM params, trailing slash), de-duplicate against the API list.

### 3.3 Job model

One HTTP request per page is the current design and it will not survive a 100-page site. Use a job:

```
POST /api/scanner/jobs          { domain, mode: 'site' | 'page', pageUrl? }  → { jobId }
GET  /api/scanner/jobs/:jobId   → { status, total, done, failed, pages: [...summaries] }
GET  /api/scanner/jobs/:jobId/pages/:pageId → full issues for one page
POST /api/scanner/jobs/:jobId/cancel
```

- **Durable Object per job** (`ScanJob`): owns the page queue, progress, cancellation and the result index. Alarms drive the loop so the client request returns immediately.
- **Cloudflare Queue** `scan-pages`: one message per page; consumer Worker runs the axe scan. Concurrency 3–5 pages per job (Workers Paid includes 10 concurrent browsers; each extra averaged browser is $2/month, each browser hour over 10 is $0.09). A 50-page site at ~8 s/page is ~7 browser-minutes, so compute cost is negligible; price on value, not cost.
- Reuse one browser per batch (`browser.newPage()` per URL, close pages, keep the browser alive with `keep_alive`) to avoid the 3-launches/second cap and cold starts. Per-page hard timeout 45 s; on failure record `{ status: 'failed', reason }` and continue.
- **Storage**: D1 for `jobs`, `pages`, `issues_summary`, `entitlements`; R2 for full per-page axe JSON (`jobs/<jobId>/<pageId>.json`). KV stays for auth and allowlist cache only. Retention 90 days (plan-dependent).
- **Progress UI**: poll every 2 s while `status === 'running'`; show "Scanned 23 of 61 pages", per-page status, and a partial results list that fills in live. Allow leaving and returning (job history).

### 3.4 Results model (site view)

- **Site-wide issues**: group identical `rule + target selector` occurring on ≥ 80 % of pages as one "global component" issue (navbar, footer, cookie banner). This collapses hundreds of duplicates into a handful of actionable fixes, which is the single biggest UX difference between a page checker and a site checker.
- **Per-page view**: today's `ResultsScreen`, reached from the page list.
- **Site score**: median of page scores plus count of global issues; keep the "relative indicator" disclaimer.
- **Diff vs previous job** for the same domain: new / fixed / unchanged issues.

### 3.5 Scheduled rescans (Pro feature)

Cron Trigger (hourly) checks D1 for due schedules (daily / weekly per site) and enqueues jobs. Every scheduled run first validates the token; on 401 it deletes the schedule and the auth record (C2). Email digest via Resend/Postmark with the diff.

---

## 4. Target architecture (after the plan)

```
Webflow Designer (iframe, *.webflow-ext.com)
  └─ Designer Extension (React, no secrets, no tokens in storage)
       │  webflow.getIdToken() + getSiteInfo()
       ▼
Cloudflare Worker  api.<brand>.com
  ├─ /oauth/install        mint state → webflow.com/oauth/authorize
  ├─ /oauth/callback       verify+consume state → exchange code → store encrypted tokens for all granted sites
  ├─ /auth/session         resolve ID token at Webflow → session JWT {sub, siteId, plan, exp 1h}
  ├─ /sites/:id/domains    allowlist (webflow.io + custom_domains), cached 1h
  ├─ /jobs ...             create / poll / cancel (entitlement + rate-limit checked)
  ├─ /billing/*            Stripe checkout, portal, webhooks
  └─ /account/delete       revoke at Webflow + purge
  ├─ Durable Object ScanJob   (queue, progress, cancel)
  ├─ Queue scan-pages         (consumer: Browser Rendering + bundled axe-core)
  ├─ D1                       (jobs, pages, summaries, entitlements, schedules)
  ├─ R2                       (full axe JSON per page, exports)
  ├─ KV                       (encrypted auth, allowlist cache, oauth state)
  └─ Cron                     (scheduled rescans, retention purge)
```

Every protected route: verify session JWT → load auth record for `claims.siteId` → confirm the record's user set includes `claims.sub` → object-level check on every job/page ID → then act. Never trust `siteId`, `jobId` or `pageUrl` from the body without those checks.

---

## 5. Compliance and legal

**Claims discipline (most important).** Never say "makes your site WCAG/ADA compliant", "compliance guaranteed" or "protects you from lawsuits". The FTC fined accessiBe $1M in 2025 for overstating what automated tooling achieves; Webflow review also checks listing honesty. Position the product as **"automated WCAG 2.2 A/AA issue detection across every page, with guidance for the manual checks automation cannot do."** Put the disclaimer in the listing, the results screen, every export and the marketing site.

**Privacy and data protection (GDPR / UK GDPR / CCPA).**
- Publish separate **Privacy Policy** and **Terms of Service** URLs plus a support email. Reviewers check they are distinct and reachable.
- Data inventory to disclose: Webflow user ID, email, first name; site ID, name, domains; Webflow OAuth access token (encrypted); scan results (URLs, HTML snippets of public page elements, timestamps); billing data (held by Stripe). No visitor data, no cookies on customer sites, no code injected.
- Sub-processors: Cloudflare (compute, storage), Webflow (API), Stripe (billing), email provider. Offer a DPA on request; Cloudflare's DPA covers hosting.
- Retention: auth until uninstall/revocation; scans 90 days (configurable), purge job via Cron; in-app delete (C3).
- Logs: redact tokens, emails and page HTML at the logging boundary.
- Tell users in-app, before the first scan, that scanning loads their published pages in a headless browser and may register as a visit if their analytics are not in the blocklist.

**Accessibility standards to reference correctly.** WCAG 2.2 Level AA (W3C Recommendation, Oct 2023); EU EN 301 549 / European Accessibility Act (applies from 28 June 2025); US ADA Title II rule (WCAG 2.1 AA for public entities, 2026–2027 deadlines) and Section 508. Cite them as what the tool *tests against*, not what it *certifies*.

**Webflow Marketplace policy items.** One developer account; minimum scopes; honour revocation; listing matches behaviour; fees disclosed; no ads; no keyboard shortcuts to invoke the app; production builds; source maps uploaded privately; App Review Preflight run with a `wfpre_…` receipt attached to the submission; test site on `.webflow.io` with the app installed; 10–15 business day review, and every later change to the bundle or backend behaviour is an **App Update** through the same review.

---

## 6. Phased roadmap

### Phase 0 — Stop the bleeding (1–2 days) — the app is live today
1. Delete `handleToken` route and `src/oauth.js` (S1, S10).
2. Verify Designer ID tokens via Webflow Resolve (S2); reject on failure.
3. Replace DNS heuristic with Webflow allowlist; fix custom-domains endpoint (S5).
4. Stop sending the session token through `postMessage` (S4); tighten CORS (S8); generic 5xx errors (S7, S12).
5. Rotate `WORKER_JWT_SECRET` so any sessions minted via S1/S2 die immediately. Deploy.

### Phase 1 — Marketplace-grade auth and hygiene (1 week)
- Server-minted, session-bound, single-use OAuth `state`; Install URL endpoint (S3, R3).
- Store tokens for all granted sites, encrypted (S6, S9); resolve site from the ID token.
- Rate Limiting binding on every route (S11); revocation handling and purge (C2, C3).
- Build hygiene: maps out of `bundle.zip`, telemetry stripped, fonts self-hosted, custom API domain, postbuild guard (R1, R2, R5, R6, R11).
- Fix the extension's own accessibility and copy (R9, R10).
- Vitest suite covering S1–S6 and object-level authorisation (C5). Staging + production environments (C6).

### Phase 2 — Whole-site scanning (2–3 weeks)
- Domain dropdown from allowlist; page discovery via List Pages + CMS sampling + optional crawl.
- `ScanJob` Durable Object + Queue consumer + D1/R2 storage + progress UI.
- Site-wide issue grouping, per-page drill-down, job history, cancel.
- Bundle axe-core, add WCAG 2.2 tags, crawler UA, password-page detection.

### Phase 3 — Commercial launch (1–2 weeks, parallel with review)
- Stripe plans and server-side entitlements (C1). Suggested tiers: Free (single-page scans, 5/month), Pro (whole-site up to 200 pages, weekly schedule, CSV/PDF export), Agency (multi-site, daily schedule, white-label PDF).
- Observability, uptime, status page, support inbox (C4).
- Privacy Policy, ToS, data disclosure screen, marketing site with disclaimer (§5).
- Listing assets, demo site, demo video (approve + deny), Preflight run, 2FA, submit (R8).

### Phase 4 — Differentiators (ongoing)
- Scheduled rescans with diff digests; "jump to element in Designer"; contrast fix suggestions; alt-text drafting; agency multi-site dashboard; public API.

---

## 7. Pre-submission checklist (go / no-go)

- [ ] No endpoint returns a session without a Webflow-verified ID token (S1, S2 tests green)
- [ ] OAuth `state` verified and consumed server-side; Install URL is ours (S3)
- [ ] Scan request for a hostname not in the site's allowlist → 403 (S5 test green)
- [ ] Site A session cannot read site B's job/page/history → 404/403 with no data (C5)
- [ ] No token in `postMessage`; no `'*'` target with credentials (S4)
- [ ] Tokens encrypted at rest; `.dev.vars` and secrets never in git (S9, C6)
- [ ] CORS production-only; `Allow-Credentials` removed (S8)
- [ ] Rate limits on every route, including auth (S11)
- [ ] 401 from Webflow → purge + stop (C2); in-app delete works (C3)
- [ ] `bundle.zip`: no `.map`, no telemetry block, one `webflow.json`, < 5 MB, production build, no localhost/ngrok/workers.dev destinations (R1, R2, R6, R11)
- [ ] Extension passes axe itself; interactive elements keyboard-operable; contrast ≥ 4.5:1 (R10)
- [ ] Copy: no compliance claims; disclaimer on results and exports (R9, §5)
- [ ] Privacy Policy, ToS, support contact live and distinct (R7)
- [ ] Demo `.webflow.io` site with app installed; demo video 2–5 min incl. OAuth deny; icon 512×512; 3–5 screenshots 1280×846 (R8)
- [ ] App Review Preflight receipt `wfpre_…`; source maps uploaded privately
- [ ] 2FA on workspace admin; backend monitored and up for the whole review window
- [ ] Fees disclosed in listing; listing text matches behaviour

---

## 8. Re-audit status — 2026-11-10

Code was revised on 2026-11-09/10. Status of every finding from §2:

| ID | Status | Notes |
|---|---|---|
| S1 | **Fixed** | `/auth/token` route removed. |
| S2 | **Fixed** | ID token resolved at `POST /beta/token/resolve`; failure rejects. Minor: the resolved user is not compared to the stored `userId`; add that check so a different Webflow user inside the same site gets their own identity. |
| S3 | **Open** | `handleAuthorize` mints and stores a state, but `handleCallback` never reads or consumes it; the code comment claims Webflow does not echo `state`. Webflow's OAuth docs say the callback includes `state` when it was passed. Verify + consume in the callback, and bind to a `HttpOnly; Secure; SameSite=None` cookie. Also: `redirect_uri` is sent on authorize but omitted on the token exchange; Webflow's troubleshooting says both must match or you get `invalid_grant`. |
| S4 | **Fixed** | Popup posts `AUTH_COMPLETE` only; success path now 302s to the Designer. Minor: the error path reads `window.opener.location.origin` cross-origin, which throws, so `AUTH_ERROR` never arrives. Use `'*'` for the error message only (it carries no secret) or drop it. |
| S5 | **Fixed** | Exact allowlist from `custom_domains` + staging; DNS heuristic gone. Note: both `www.` and apex are added for every custom domain even if Webflow lists only one; acceptable (same registrable domain). |
| S6 | **Fixed** | Tokens stored for every granted site. Minor: post-auth redirect goes to `sites[0]`, not the site that started the flow (the `siteId` saved in state is unused). |
| S7, S8, S10, S12, S13, S14 | **Fixed** | |
| S9 | **Fixed with a gap** | AES-GCM in place, but `encryptPayload`/`decryptPayload` silently no-op when `TOKEN_ENC_KEY` is missing and fall back to plaintext on decrypt failure. Fail closed in production (`throw` when the secret is absent) and confirm the secret is set with `wrangler secret list`. |
| S11 | **Open** | Still a racy KV counter; limit was raised from 20 to 500 per site per day (comment still says 20). No limit on `designer-token` or OAuth routes. Needs the Rate Limiting binding or a Durable Object, plus entitlement-based limits. |
| R1 | **Open** | Webpack now emits maps to `maps/` with `hidden-source-map`, but stale `public/bundle.js.map` and `public/bundle.css.map` remain and `bundle.zip` (built 2026-11-10) still contains both. Delete them and rebuild. |
| R2, R4, R5, R9 | **Fixed** | |
| R3 | **Partial** | `/oauth/install` exists but inherits the S3 gap. |
| R6 | **Open** | Still `workers.dev`; also hard-coded in the scanner user-agent string. |
| R7, R8 | **Open** | Policies, listing assets, demo site, video, Preflight run. |
| R10 | **Partial** | Issue cards and history rows are now `<button>` elements. Contrast is unchanged: 50 occurrences of white text at ≤ 0.45 alpha across the components and stylesheet. |
| R11 | **Open** | No post-build guard. |
| C2, C3, C4, C5, C6 | **Open** | No revocation purge on 401, no delete-my-data, logs still disabled, no tests, no staging environment. |
| P3 items | **Fixed** | axe-core bundled and injected inline; WCAG 2.2 tags added; crawler UA + `X-Accessibility-Scan` header; private-IP request blocking; `/.wf_auth` password-page detection. |

**Whole-site scanning, current state.** Page discovery via the Data API is in (`GET /api/scanner/sites/:siteId/pages`, filtered for drafts/archived, URL built from `publishedPath` on the staging domain first). The UI lists pages with select-all and runs them one by one. Remaining gaps:

- **Client-driven loop.** Each page is a separate HTTP request that launches and tears down a browser. A 60-page site takes roughly 10 minutes with the Designer panel open; closing the panel loses the run. The job model in §3.3 is still needed.
- **CMS template pages scan the wrong URL.** The UI says a CMS template "scans one published item", but the server returns the template's own `publishedPath`, which is not a live item URL. This needs `cms:read` and one item fetched from `GET /v2/collections/{id}/items`.
- **No site-level persistence.** History still stores single pages; a site run is not saved as one job, so there is no diff between runs and no "resume".
- **No site-wide grouping** of repeated issues (nav, footer).
- **Scan domain is not user-selectable.** The server always prefers the staging domain; production custom domains are never scanned unless the staging URL happens to be absent.
- **Password-protected pages** are reported as "Scan failed" instead of "Skipped: password-protected", and there is no way to supply a site password (see §9).

## 9. Competitive position (added 2026-11-10)

Sources checked 2026-11-10: accessiBe accessFlow docs and pricing, accessiBe support articles on non-public sites and pre-audit actions, UserWay Accessibility Monitor help centre and pricing, Webflow integration pages for both, FTC press releases, plus Siteimprove, Deque axe Monitor, Pope Tech, Silktide and Lighthouse CI docs.

### 9.1 Does the competition scan every page? Yes, and it is table stakes.

| | accessiBe accessFlow | UserWay Accessibility Monitor | Us (today) |
|---|---|---|---|
| Discovery | Homepage-seeded link crawl per domain; manual add/remove; SPA routes need "Journeys" | Builds a sitemap from `sitemap.xml`, user picks pages; manual URL add | Webflow Data API page list (better: authoritative, catches pages with no inbound links) |
| Page quota | 1,000 / 5,000 / unlimited by plan; trial scans a few pages | 100 / 500 / 1,500 pages per month | 500 scans/site/day hard-coded, no plans |
| Rescan cadence | Monthly / bi-weekly / weekly by plan, plus 10–150 on-demand page scans per day | User picks: daily, 3-day, weekly, bi-weekly, monthly, quarterly | None |
| Crawl politeness | ~2 page requests per minute | Configurable rate limit, 3 s wait-for-load, scroll | Sequential, one browser per page |
| Standard | WCAG 2.1 AA (2.2 mentioned in newer copy) | WCAG 2.1 or 2.2 AA, optional AAA | WCAG 2.1 + 2.2 A/AA via axe-core (parity or better) |
| Engine | Undisclosed "AI engine" | Undisclosed headless crawler | axe-core 4.10, disclosed (a trust advantage) |
| Grouping | By severity / rule / page with occurrence counts | Site-wide (template) vs homepage vs page violations | Per page only |
| Workflow | Remediation panel, Jira/Asana/ClickUp/GitHub tickets, alerts | Important / Resolve / Dismiss / Ignore-rule, screenshots desktop+mobile | None |
| Export | PDF dashboard export | PDF full and open-violations reports | None |
| Webflow app | Marketplace app installs the widget only, no accessFlow scanning inside Webflow | No Marketplace app, custom-code install | Native Designer Extension (our differentiator) |
| Pricing | Quote only | $990 / $4,490 / $10,990 per year | Undefined |

The accessiBe Webflow app the user described (24-hour rescans, 48-hour initial window) is the **widget**, not a scanner the Webflow user can drive. Neither competitor offers a page-by-page audit inside the Webflow Designer. That is the gap to own.

### 9.2 How competitors scan password-protected pages

Every serious scanner supports some subset of six patterns; none supports MFA or CAPTCHA.

1. **HTTP Basic Auth credentials** (accessiBe "Auth Prompt", UserWay, Siteimprove, Deque, Pope Tech, Silktide).
2. **Form login via CSS selectors** for username, password, submit, plus a "success selector" (UserWay Form Authentication, Pope Tech, Silktide staff-configured, accessiBe pre-audit actions).
3. **Scripted or recorded multi-step login** (accessiBe browser-extension recorder; UserWay Scenario Authentication; Deque session scripts; Lighthouse CI `puppeteerScript`).
4. **Pasted cookie or custom header** as the MFA fallback (accessiBe, Lighthouse CI `extraHeaders`). accessiBe caps cookies at 5,000 chars and does not support third-party cookies.
5. **Custom User-Agent** so the site can recognise or exempt the crawler (accessiBe, Deque, Silktide).
6. **Published static egress IPs** for firewall allowlisting (accessiBe, UserWay, Silktide).

**What we should build, in order.**

- **Webflow-native password support first.** Webflow page and site passwords are one form posting to `/.wf_auth`. Let the user enter the site password (and per-page passwords) in the app; store them encrypted with `TOKEN_ENC_KEY` per site; the scanner submits that form, then proceeds. This is the Webflow equivalent of "form authentication" with no selectors for the user to figure out, and it covers the one gating mechanism nearly every Webflow site actually uses (staging passwords, client previews, unreleased pages). Report pages where the password fails as "Skipped: password rejected" rather than "failed".
- **Cookie / header paste as the fallback** for Memberships or third-party gates, with the same guardrails as accessiBe: encrypted at rest, size-capped, never logged, sent only to hostnames on the site allowlist, never to third-party requests the page makes.
- **HTTP Basic Auth** is cheap to add with Puppeteer `page.authenticate()`.
- **Do not promise static IPs.** Cloudflare Browser Rendering does not give fixed egress addresses, so document the User-Agent and `X-Accessibility-Scan` header as the way to recognise us instead.
- Scripted multi-step login is a Phase 4 item at most; Webflow sites rarely need it.

### 9.3 What we are missing against the market checklist

Have: authoritative page discovery, headless rendering with scroll, WCAG 2.1/2.2 A/AA rule set, severity, per-issue WCAG links, per-page view, fix guidance, score, disclaimer, domain lock.

Missing, ordered by how often buyers ask for it:

1. Background job with progress that survives closing the panel (§3.3).
2. Scheduled rescans with "new / fixed" diff and email alerts.
3. Site-wide vs page-level grouping of repeated issues.
4. Plan-based page quotas shown as "pages scanned vs quota".
5. PDF export (full and open issues), then CSV/JSON.
6. Password-protected page support as in §9.2.
7. Issue workflow: resolve, dismiss, ignore rule, false-positive marking.
8. Element screenshots per issue (desktop and mobile viewport).
9. Correct CMS template scanning (sample live items).
10. Ticketing integration (ClickUp, Jira, GitHub) and a CI token. Later.

### 9.4 Compliance verdict

- **Webflow API usage:** compliant in approach. Pages come from `pages:read`, domains from `sites:read`, identity from the Resolve ID Token endpoint, scopes minimal. Open review items are S3 (state verification), S11 (rate limiting), R1 (maps in the bundle), C2 (revocation purge) and the listing/legal assets.
- **Claims:** compliant. Copy now says "no issues detected by automated checks" and carries the coverage disclaimer. Keep it that way. The FTC's April 2025 order against accessiBe ($1,000,000) bars claims that automated products can make a site WCAG-compliant or keep it compliant; UserWay faces a Delaware consumer-fraud class action over similar marketing. Our wording must stay at "detect", "help", "support".
- **Privacy:** not yet compliant for a paid product. No privacy policy, terms, data-deletion path or revocation purge. Adding password and cookie storage (§9.2) raises the bar further: those are credentials, so encryption must fail closed (S9 gap), retention must be short, and the disclosure screen must name them.
- **Own accessibility:** not yet. Contrast failures remain across the UI (R10).

## 10. Immediate next action

Start Phase 0 now. The five items are small, self-contained edits to `src/worker.js`, `src/auth/designerToken.js`, `src/auth/oauth.js` and `src/hooks/useAuth.ts`, plus a secret rotation and a deploy. Nothing else in this plan should ship before they do.
