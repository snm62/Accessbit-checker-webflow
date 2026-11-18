# Fix Guide — every pending item, with the industry-standard fix

Companion to MARKET-READINESS-PLAN.md. Ordered by what unblocks Marketplace review first, then what makes large sites work, then commercial polish. Each fix names the file, the change, and how to verify it.

---

## A. Review blockers

### A1. OAuth `state` is minted but never verified — `src/auth/oauth.js`

Standard: RFC 6749 §10.12 and Webflow's OAuth guide. State is random, single-use, bound to the browser that started the flow, verified and consumed atomically before the code exchange.

**handleAuthorize** — bind the state to a cookie:

```js
const stateToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
await env.TOKENS.put(`scanner:oauth_state:${stateToken}`,
  JSON.stringify({ siteId, createdAt: Date.now() }), { expirationTtl: 600 });

return new Response(null, {
  status: 302,
  headers: {
    Location: `${WEBFLOW_AUTH_URL}?${params}`,
    'Set-Cookie': `wf_state=${stateToken}; Path=/api/scanner/auth; Max-Age=600; HttpOnly; Secure; SameSite=None`,
  },
});
```

**handleCallback** — verify and consume before anything else:

```js
const state       = url.searchParams.get('state');
const cookieState = getCookie(request, 'wf_state');

if (!state || !cookieState || state !== cookieState) {
  console.error('OAuth state mismatch');
  return popupPage({ error: 'Authorization could not be verified. Please try again.' });
}
const stateKey = `scanner:oauth_state:${state}`;
const stateRaw = await env.TOKENS.get(stateKey);
await env.TOKENS.delete(stateKey);                 // consume first — single use
if (!stateRaw) return popupPage({ error: 'Authorization expired. Please try again.' });
const { siteId: originSiteId } = JSON.parse(stateRaw);
```

Also send `redirect_uri` in the token exchange body, because you send it on authorize and Webflow's troubleshooting says the two must match:

```js
body: JSON.stringify({ client_id, client_secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
```

Use `originSiteId` for the final redirect instead of `sites[0]`, and clear the cookie with `Max-Age=0` on the response.

Verify: open the install URL, edit the `state` query param on the callback URL, expect the error page. Replay a used callback URL, expect "expired".

### A2. Source maps inside `bundle.zip` — build

Standard: production artifact contains only what ships; maps are uploaded privately.

```bash
rm public/bundle.js.map public/bundle.css.map
npm run build
unzip -l bundle.zip        # must list webflow.json, bundle.js, bundle.css, index.html only
```

Add to `package.json` so it cannot regress:

```json
"postbuild-webpack": "node -e \"const fs=require('fs');for(const f of fs.readdirSync('public')){if(f.endsWith('.map'))throw new Error('map in public: '+f)}\"",
"build": "npm run build-webpack && npm run postbuild-webpack && npm run guard && webflow extension bundle",
"guard": "node -e \"const s=require('fs').readFileSync('public/bundle.js','utf8');for(const bad of ['localhost:','127.0.0.1','ngrok','workers.dev'])if(s.includes(bad))throw new Error('forbidden host in bundle: '+bad)\""
```

(Remove `workers.dev` from the guard list until A4 is done.)

### A3. Encryption falls back to plaintext — `src/auth/crypto.js`

Standard: fail closed. A missing key is an outage, not a downgrade.

```js
function requireKey(env) {
  if (!env.TOKEN_ENC_KEY || !/^[0-9a-f]{64}$/i.test(env.TOKEN_ENC_KEY)) {
    throw Object.assign(new Error('TOKEN_ENC_KEY missing or malformed'), { status: 500 });
  }
  return env.TOKEN_ENC_KEY;
}
export async function encryptPayload(plaintext, env) {
  const key = await importKey(requireKey(env));
  // ... unchanged, but prefix the output with "v1:" so you can rotate later
  return 'v1:' + btoa(String.fromCharCode(...combined));
}
export async function decryptPayload(ciphertext, env) {
  const key = await importKey(requireKey(env));
  if (!ciphertext.startsWith('v1:')) throw new Error('unencrypted record');  // no plaintext fallback
  // ... decrypt; let errors propagate
}
```

One-time migration: a small script that reads every `scanner:auth:*` key, decrypts with the old fallback, re-encrypts with the `v1:` prefix. Then deploy the fail-closed version. Confirm with `npx wrangler secret list`.

### A4. Production hostname — `wrangler.toml`, `src/util/constants.ts`, `src/scanner.js`

Standard: a domain you control, not a platform subdomain.

```toml
routes = [{ pattern = "api.yourbrand.com", custom_domain = true }]
[vars]
WEBFLOW_APP_URL = "https://api.yourbrand.com"
ENVIRONMENT = "production"

[env.staging]
name = "accessibility-checker-staging"
routes = [{ pattern = "api-staging.yourbrand.com", custom_domain = true }]
[env.staging.vars]
WEBFLOW_APP_URL = "https://api-staging.yourbrand.com"
ENVIRONMENT = "staging"
```

Update `WORKER_BASE_URL`, the scanner user-agent URL, the Webflow app redirect URI, and the Marketplace Install URL. Separate KV namespace IDs per env.

### A5. Rate limiting — `src/worker.js`

Standard: atomic counters, every route, per site and per IP, plan-aware.

```toml
[[unsafe.bindings]]
name = "RL_SCAN"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 30, period = 60 }      # 30 scan requests per site per minute

[[unsafe.bindings]]
name = "RL_AUTH"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 20, period = 60 }      # 20 auth calls per IP per minute
```

```js
async function limit(binding, key) {
  const { success } = await binding.limit({ key });
  if (!success) throw Object.assign(new Error('Too many requests. Please wait a minute.'), { status: 429 });
}
// auth routes
await limit(env.RL_AUTH, request.headers.get('CF-Connecting-IP') ?? 'unknown');
// scan route
await limit(env.RL_SCAN, req._claims.siteId);
```

Keep a daily quota too, but read it from the entitlement record (see C1) and count it inside the Durable Object job (B1), where increments are serialised and race-free. Delete the KV counter.

### A6. Revocation handling — `src/worker.js`, `src/auth/designerToken.js`

Standard: a persistent 401 from Webflow on a previously valid token is uninstall. Stop, forget, never retry.

```js
async function fetchWebflow(accessToken, path, siteId, env) {
  const res = await fetch(`https://api.webflow.com${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401 && siteId) {
    await purgeSite(siteId, env);
    throw Object.assign(new Error('This site disconnected the app. Please reinstall.'), { status: 401 });
  }
  return res;
}

async function purgeSite(siteId, env) {
  await env.TOKENS.delete(`scanner:auth:${siteId}`);
  await env.TOKENS.delete(`scanner:domaincache:${siteId}`);
  // schedules + D1 rows when they exist; scans can age out or be deleted here too
}
```

Use this wrapper for every Webflow call, including the resolve call in `designerToken.js`.

### A7. Delete-my-data — new route

Standard: user-initiated revocation plus purge, reachable from the app.

```js
if (pathname === '/api/scanner/account' && method === 'DELETE') {
  const req = await requireSession(request, env);
  await fetch('https://webflow.com/oauth/revoke_authorization', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.WEBFLOW_CLIENT_ID, client_secret: env.WEBFLOW_CLIENT_SECRET, access_token: req._accessToken }),
  }).catch(() => {});
  await purgeSite(req._claims.siteId, env);
  // also delete scanner:scan:* for this site (list by prefix) and history
  return withCors(jsonResponse({ ok: true }), cors);
}
```

Wire the existing "Disconnect" button to call it, with a confirm step: "This revokes access and deletes all scan data for this site."

### A8. Session claims — `src/auth/jwt.js`

```js
iss: 'accessibility-checker', aud: 'designer-extension', ...
// verify:
if (claims.iss !== 'accessibility-checker' || claims.aud !== 'designer-extension') throw new Error('bad audience');
```

And in `designerToken.js`, after resolve succeeds, compare `resolved.id` with `stored.userId`; if different, sign the session with `resolved.id` and store the user record, rather than impersonating the original installer.

### A9. Observability — `wrangler.toml`

```toml
[observability.logs]
enabled = true
invocation_logs = true
head_sampling_rate = 1
```

Never log tokens, cookies, passwords, emails or page HTML. Add an external uptime check on `/health` and route errors to Sentry or Workers Analytics Engine.

### A10. Extension accessibility — `src/styles/main.css` and components

Standard: WCAG AA 4.5:1 for body text, 3:1 for large text and UI borders, visible focus.

On `#0A081B`, white at 0.35 alpha is about 3:1. Use these tokens and replace every inline `rgba(255,255,255,0.3–0.45)`:

```css
:root {
  --text-primary:   rgba(255,255,255,0.92);  /* ~17:1 */
  --text-secondary: rgba(255,255,255,0.72);  /* ~11:1 */
  --text-muted:     rgba(255,255,255,0.60);  /* ~7.5:1 — minimum for small text */
  --border:         rgba(255,255,255,0.18);
}
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid #59AAFB; outline-offset: 2px; }
```

Also set `aria-live="polite"` on the progress text, give the page-list checkboxes visible labels (they have them via `<label>`, good), and run axe against the extension in CI (Playwright + `@axe-core/playwright` against `public/index.html`).

### A11. Tests — new `test/` with Vitest + `@cloudflare/vitest-pool-workers`

Minimum suite before submission:

- designer-token: malformed token → 401; resolve failure → 401; success → JWT with correct `siteId`.
- OAuth callback: missing/mismatched/reused state → error page; valid → tokens stored for every site.
- Domain lock: hostname not in allowlist → 403; `www` and apex handled; `*.webflow.io` of another site → 403.
- Object-level auth: session for site A requesting site B's pages or scan → 403/404 with no data.
- Rate limit: 31st request in a minute → 429.
- Crypto: missing key → throws; round trip works; unprefixed record → throws.

---

## B. Whole-site scanning at scale

### B1. Background job with Durable Object + Queue

Standard: scan runs server-side, survives the client, exposes progress, supports cancel, bounded concurrency.

```toml
[[durable_objects.bindings]]
name = "SCAN_JOB"
class_name = "ScanJob"
[[migrations]]
tag = "v1"
new_classes = ["ScanJob"]

[[queues.producers]]
binding = "SCAN_QUEUE"
queue = "scan-pages"
[[queues.consumers]]
queue = "scan-pages"
max_batch_size = 1
max_concurrency = 5
max_retries = 2
```

Routes:

```
POST /api/scanner/jobs                 { domain, pageIds? }      → { jobId }
GET  /api/scanner/jobs/:id             → { status, total, done, failed, pages:[{pageId,title,path,status,summary}] }
GET  /api/scanner/jobs/:id/pages/:pid  → full issues
POST /api/scanner/jobs/:id/cancel
```

ScanJob (sketch):

```js
export class ScanJob {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/start') {
      const { siteId, pages } = await req.json();
      await this.state.storage.put('meta', { siteId, status: 'running', total: pages.length, done: 0, failed: 0, startedAt: Date.now() });
      for (const p of pages) {
        await this.state.storage.put(`page:${p.pageId}`, { ...p, status: 'queued' });
        await this.env.SCAN_QUEUE.send({ jobId: this.state.id.toString(), siteId, page: p });
      }
      return Response.json({ ok: true });
    }
    if (pathname === '/page-done') {                // called by the queue consumer
      const { pageId, summary, error } = await req.json();
      const meta = await this.state.storage.get('meta');
      if (meta.status === 'cancelled') return Response.json({ ok: true });
      const page = await this.state.storage.get(`page:${pageId}`);
      await this.state.storage.put(`page:${pageId}`, { ...page, status: error ? 'failed' : 'done', summary, error });
      meta.done++; if (error) meta.failed++;
      if (meta.done >= meta.total) meta.status = 'complete';
      await this.state.storage.put('meta', meta);
      return Response.json({ ok: true });
    }
    if (pathname === '/status') {
      const meta = await this.state.storage.get('meta');
      const pages = [...(await this.state.storage.list({ prefix: 'page:' })).values()];
      return Response.json({ ...meta, pages });
    }
    if (pathname === '/cancel') {
      const meta = await this.state.storage.get('meta');
      await this.state.storage.put('meta', { ...meta, status: 'cancelled' });
      return Response.json({ ok: true });
    }
  }
}
```

Queue consumer: check the job is not cancelled, re-validate the hostname against the allowlist (never trust the queued URL blindly), run the scan, write full issues to R2 at `jobs/<jobId>/<pageId>.json`, post the summary to `/page-done`. The job ID is random; the worker checks `meta.siteId === claims.siteId` on every status/page read for object-level authorisation.

Frontend: replace the loop in `ScannerScreen.tsx` with one POST, then poll status every 2 s; show per-page rows filling in; store the last job ID in `localStorage` so reopening the panel resumes the view.

### B2. One browser per batch

Inside the consumer, keep a browser across the batch and open a new `page` per URL. With `max_batch_size = 1` and five concurrent consumers you get five browsers; switch to `max_batch_size = 5` with a shared browser per invocation once stable. Always `page.close()` in `finally`.

### B3. CMS template pages — `listSitePages`

Request the `cms:read` scope (one more scope, justified in the listing). For each page with `collectionId`:

```js
const items = await fetchWebflow(token, `/v2/collections/${p.collectionId}/items?limit=${sampleSize}`, siteId, env).then(r => r.json());
const live = (items.items ?? []).filter(i => !i.isDraft && !i.isArchived);
// template publishedPath looks like "/blog/detail_post"; the item URL is the collection slug + item slug
for (const it of live) pages.push({ ...p, pageId: `${p.id}:${it.id}`, path: `/${collectionSlug}/${it.fieldData.slug}`, isCmsItem: true });
```

Get `collectionSlug` from `GET /v2/collections/{id}`. Sample size by plan: 3 / 10 / all.

### B4. Domain picker

`GET /api/scanner/sites/:id/domains` returns the allowlist; the UI shows a select with staging first and remembers the choice per site. `listSitePages` takes `?domain=` and validates it against the allowlist before building URLs.

### B5. Skipped states

In the scanner, return `{ status: 'skipped', reason: 'password-protected' | 'redirected' | 'not-found' }` instead of throwing for those cases, so the job marks them skipped and the UI shows the reason. Treat HTTP 404 and 410 as `not-found`.

### B6. Webflow password support

Settings field "Site password" (encrypted, per site). In the scanner, when `form[action="/.wf_auth"]` is present:

```js
await page.type('form[action="/.wf_auth"] input[type="password"]', sitePassword);
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('form[action="/.wf_auth"] [type="submit"]')]);
const stillGated = await page.$('form[action="/.wf_auth"]');
if (stillGated) return { status: 'skipped', reason: 'password-rejected' };
```

Confirm the input names on a real protected page first. Do it once per job and reuse the browser context so the cookie carries over.

---

## C. Commercial layer

### C1. Entitlements and quotas

D1 table `entitlements(site_id PK, plan, pages_per_scan, scans_per_month, scheduled, stripe_customer_id, updated_at)`. Stripe Checkout creates or upgrades the row via webhook; `POST /jobs` reads it and refuses over-quota with a clear message that names the limit. Free tier default when no row exists.

### C2. Scheduled rescans

```toml
[triggers]
crons = ["0 * * * *"]
```

`scheduled()` handler: select schedules due in D1, create a job for each, mark next run. Each job starts with a `/v2/token/authorized_by` check; a 401 purges the site and deletes the schedule. Email the diff (new / fixed / unchanged, by rule) via Resend or Postmark.

### C3. Site-wide grouping

In the status aggregation: key by `rule + target`; if the same key appears on ≥ 80% of scanned pages, surface it once under "Site-wide (navigation, footer, templates)" with the page count, and exclude those occurrences from per-page counts. This is the single largest UX improvement over a page list.

### C4. PDF and CSV export

Render a print stylesheet of the site report in the same headless browser and `page.pdf()`; store in R2 and return a short-lived signed URL. Bake the coverage disclaimer into header and footer. CSV: one row per issue with page, rule, WCAG criterion, level, impact, selector, snippet, help URL.

### C5. Issue workflow

D1 table `issue_state(site_id, fingerprint, state: 'open'|'resolved'|'dismissed'|'ignored-rule', note, updated_by, updated_at)`. Fingerprint = hash of rule + normalised selector + page path. Apply on every job so the dashboard shows open vs dismissed.

### C6. Legal and listing

Publish separate Privacy Policy and Terms URLs, support email, an in-app "What we store" screen listing: Webflow user ID and email, site ID and domains, encrypted access token, encrypted site passwords if provided, scan results for 90 days. Listing copy limited to "detects", "reports", "helps you fix". Demo `.webflow.io` site with the app installed, 2 to 5 minute video including OAuth deny, 512×512 icon, 3 to 5 screenshots at 1280×846, Preflight receipt, 2FA on the workspace admin.

---

## Suggested order of work

1. A1, A2, A3, A5, A6 — two days. Submit nothing before these.
2. A4, A7, A8, A9, A10, A11 — three to four days.
3. B1 through B5 — about two weeks. B6 after.
4. C6 in parallel with step 3; C1 and C2 next; C3, C4, C5 after launch.
