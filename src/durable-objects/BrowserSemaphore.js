/**
 * BrowserSemaphore Durable Object
 *
 * Controls access to the 10 Cloudflare Browser Rendering slots.
 * Reserves 8 for queue workers, 2 for single-page scans.
 * Cap: max 2 leases per site at once so one large site can't starve others.
 *
 * Usage:
 *   const id  = env.BROWSER_SEMAPHORE.idFromName('global');
 *   const stub = env.BROWSER_SEMAPHORE.get(id);
 *   const { leaseId } = await stub.acquire(siteId);
 *   // ... do browser work ...
 *   await stub.release(leaseId);
 */

const MAX_LEASES   = 8;    // reserve 2 slots for single-page scans
const MAX_PER_SITE = 2;    // fairness cap per site
const LEASE_TTL_MS = 120_000; // 2 minutes — evicts crashed consumers

export class BrowserSemaphore {
  constructor(ctx, env) {
    this.ctx = ctx;
    // leases: Map<leaseId, { siteId, expiresAt }>
    this.leases = new Map();
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get('leases');
      if (stored) this.leases = new Map(stored);
    });
  }

  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.searchParams.get('action');
    const body   = await request.json().catch(() => ({}));

    this._evictExpired();

    if (action === 'acquire') {
      return this._acquire(body.siteId ?? 'unknown');
    }
    if (action === 'release') {
      return this._release(body.leaseId);
    }
    if (action === 'status') {
      return Response.json({ active: this.leases.size, max: MAX_LEASES });
    }
    return new Response('Not found', { status: 404 });
  }

  _evictExpired() {
    const now = Date.now();
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(id);
    }
  }

  async _acquire(siteId) {
    const activeForSite = [...this.leases.values()].filter(l => l.siteId === siteId).length;

    if (this.leases.size >= MAX_LEASES || activeForSite >= MAX_PER_SITE) {
      return Response.json({ acquired: false }, { status: 429 });
    }

    const leaseId  = crypto.randomUUID();
    const expiresAt = Date.now() + LEASE_TTL_MS;
    this.leases.set(leaseId, { siteId, expiresAt });
    await this.ctx.storage.put('leases', [...this.leases]);

    return Response.json({ acquired: true, leaseId });
  }

  async _release(leaseId) {
    if (!leaseId || !this.leases.has(leaseId)) {
      return Response.json({ released: false });
    }
    this.leases.delete(leaseId);
    await this.ctx.storage.put('leases', [...this.leases]);
    return Response.json({ released: true });
  }
}

// ── Helper used by consumers/scanner ─────────────────────────────────────────

export async function acquireBrowserSlot(env, siteId) {
  const stub = env.BROWSER_SEMAPHORE.get(env.BROWSER_SEMAPHORE.idFromName('global'));
  const res  = await stub.fetch(
    new Request('https://do/semaphore?action=acquire', {
      method: 'POST',
      body:   JSON.stringify({ siteId }),
      headers: { 'Content-Type': 'application/json' },
    })
  );
  return res.json();
}

export async function releaseBrowserSlot(env, leaseId) {
  if (!leaseId) return;
  const stub = env.BROWSER_SEMAPHORE.get(env.BROWSER_SEMAPHORE.idFromName('global'));
  await stub.fetch(
    new Request('https://do/semaphore?action=release', {
      method: 'POST',
      body:   JSON.stringify({ leaseId }),
      headers: { 'Content-Type': 'application/json' },
    })
  ).catch(() => {});
}
