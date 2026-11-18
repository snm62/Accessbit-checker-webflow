import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SiteInfo } from '../hooks/useAuth';
import '../styles/scannerscreen.css';

interface Props {
  siteInfo: SiteInfo | null;
  onScanComplete: (pageScanResults: PageScanResult[], meta?: { durationMs: number }) => void;
  makeAuthRequest: (path: string, init?: RequestInit) => Promise<Response>;
  onLogout: () => void;
  onHistory: () => void;
}

export interface SitePage {
  pageId: string;
  title: string;
  slug: string;
  path: string;
  url: string;
  isCmsTemplate: boolean;
  collectionId: string | null;
  parentId: string | null;
}

export interface ScanResult {
  rule: string;
  wcag: string;
  level: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  message: string;
  howToFix: string;
  helpUrl: string;
  category: 'accessibility' | 'best-practice';
  target: string | null;
}

export interface PageScanResult {
  page: SitePage;
  issues: ScanResult[];
  summary: {
    total: number;
    accessibility: number;
    bestPractice: number;
    byCritical: number;
    bySerious: number;
    byModerate: number;
    byMinor: number;
    score: number;
  };
  error?: string;
  skipped?: 'password-protected' | 'redirected';
  scannedAt: string;
  durationMs: number;
}

interface JobStatus {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  totalPages: number;
  donePages: number;
  failedPages: number;
  skippedPages: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pages?: Array<{
    pageId: string;
    url: string;
    title: string;
    isCms: boolean;
    status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
    error: string | null;
    summary: any | null;
    durationMs?: number;
  }>;
}

const POLL_INTERVAL_MS = 4000;

/* ── Score ring (SVG) ───────────────────────────────────────────────────── */
const ScanRing: React.FC<{ done: number; total: number }> = ({ done, total }) => {
  const r = 68;
  const circ = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  const dash = pct * circ;

  return (
    <div className="scan-ring-wrap">
      <svg width="120" height="120" viewBox="0 0 160 160" fill="none" aria-hidden="true">
        <circle cx="80" cy="80" r={r} stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
        <circle
          cx="80" cy="80" r={r}
          stroke="url(#scanGrad)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
        <defs>
          <linearGradient id="scanGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--purple)" />
            <stop offset="100%" stopColor="var(--green)" />
          </linearGradient>
        </defs>
      </svg>
      <div className="scan-ring-label">
        <div className="scan-ring-count">
          <span className="scan-ring-num">{done}</span>
          <span className="scan-ring-sep">/{total}</span>
        </div>
        <span className="scan-ring-denom">PAGES</span>
      </div>
    </div>
  );
};

/* ── Main component ─────────────────────────────────────────────────────── */
const ScannerScreen: React.FC<Props> = ({ siteInfo, onScanComplete, makeAuthRequest, onLogout, onHistory }) => {
  const [pages, setPages] = useState<SitePage[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pagesLoading, setPagesLoading] = useState(false);
  const [pagesError, setPagesError] = useState<string | null>(null);

  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanStartRef = useRef<number | null>(null);

  const isScanning = activeJob !== null && !['done', 'failed', 'cancelled'].includes(activeJob.status);

  useEffect(() => {
    if (!siteInfo?.siteId) return;
    fetchPages();
    checkActiveJob();
  }, [siteInfo?.siteId]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function fetchPages() {
    if (!siteInfo?.siteId) return;
    setPagesLoading(true);
    setPagesError(null);
    setPages([]);
    setSelectedIds(new Set());
    makeAuthRequest(`/api/scanner/sites/${siteInfo.siteId}/pages`)
      .then(res =>
        res.ok
          ? (res.json() as Promise<{ pages: SitePage[] }>)
          : (res.json() as Promise<any>).then(d => Promise.reject(new Error(d.error || `Error ${res.status}`)))
      )
      .then(data => {
        setPages(data.pages);
        setSelectedIds(new Set(data.pages.map((p: SitePage) => p.pageId)));
      })
      .catch((err: Error) => setPagesError(err.message))
      .finally(() => setPagesLoading(false));
  }

  async function checkActiveJob() {
    try {
      const res = await makeAuthRequest('/api/scanner/jobs/active');
      if (!res.ok) return;
      const job: JobStatus | null = await res.json();
      if (job) { setActiveJob(job); startPolling(job.jobId); }
    } catch {}
  }

  function startPolling(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS);
  }

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await makeAuthRequest(`/api/scanner/jobs/${jobId}`);
      if (!res.ok) return;
      const job: JobStatus = await res.json();
      setActiveJob(job);
      if (!['queued', 'running'].includes(job.status) && job.startedAt && !scanStartRef.current) {
        scanStartRef.current = new Date(job.startedAt).getTime();
      }
      if (job.status === 'running' && job.startedAt && !scanStartRef.current) {
        scanStartRef.current = new Date(job.startedAt).getTime();
      }
      if (['done', 'failed', 'cancelled'].includes(job.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
        if (job.status === 'done' && job.pages) {
          const pageMap = new Map(pages.map(p => [p.pageId, p]));
          const results: PageScanResult[] = job.pages.map(jp => {
            const page: SitePage = pageMap.get(jp.pageId) ?? {
              pageId: jp.pageId, title: jp.title, slug: '', path: '',
              url: jp.url, isCmsTemplate: jp.isCms, collectionId: null, parentId: null,
            };
            const emptySummary = { total: 0, accessibility: 0, bestPractice: 0, byCritical: 0, bySerious: 0, byModerate: 0, byMinor: 0, score: 100 };
            if (jp.status === 'done' && jp.summary) {
              return { page, issues: jp.summary.issues ?? [], summary: jp.summary, scannedAt: new Date().toISOString(), durationMs: jp.durationMs ?? 0 };
            }
            const isPass = (jp.error ?? '').toLowerCase().includes('password');
            const isRedir = (jp.error ?? '').toLowerCase().includes('redirect');
            return {
              page, issues: [], summary: emptySummary,
              ...(jp.status === 'skipped'
                ? (isPass ? { skipped: 'password-protected' as const } : isRedir ? { skipped: 'redirected' as const } : { error: jp.error ?? 'Skipped' })
                : { error: jp.error ?? `Page ${jp.status}` }),
              scannedAt: new Date().toISOString(), durationMs: 0,
            };
          });
          const durationMs = job.finishedAt && job.startedAt
            ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
            : scanStartRef.current ? Date.now() - scanStartRef.current : 0;
          onScanComplete(results, { durationMs });
        }
        if (job.status === 'failed') setScanError('The scan failed. Check individual page results.');
      }
    } catch {}
  }, [pages, makeAuthRequest, onScanComplete]);

  const startScan = async () => {
    if (!selectedIds.size || isScanning || scanLoading) return;
    setScanError(null);
    setScanLoading(true);
    scanStartRef.current = null;
    try {
      const res = await makeAuthRequest('/api/scanner/jobs', {
        method: 'POST',
        body: JSON.stringify({ pageIds: [...selectedIds] }),
      });
      const data = await res.json() as any;
      if (res.status === 409) {
        const runningId: string = data.runningJobId;
        if (runningId) {
          setActiveJob({ jobId: runningId, status: 'running', totalPages: 0, donePages: 0, failedPages: 0, skippedPages: 0, createdAt: '', startedAt: null, finishedAt: null });
          startPolling(runningId);
        } else setScanError(data.error || 'A scan is already running.');
        return;
      }
      if (res.status === 402) { setScanError(data.error || 'Quota exceeded.'); return; }
      if (!res.ok) { setScanError(data.error || `Failed to start scan (${res.status}).`); return; }
      const job: JobStatus = { jobId: data.jobId, status: 'queued', totalPages: data.total, donePages: 0, failedPages: 0, skippedPages: 0, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
      setActiveJob(job);
      startPolling(job.jobId);
    } catch (err: any) {
      setScanError(err.message || 'Network error starting scan.');
    } finally {
      setScanLoading(false);
    }
  };

  const cancelScan = async () => {
    if (!activeJob) return;
    try {
      await makeAuthRequest(`/api/scanner/jobs/${activeJob.jobId}/cancel`, { method: 'POST' });
      setActiveJob(prev => prev ? { ...prev, status: 'cancelled' } : null);
      if (pollRef.current) clearInterval(pollRef.current);
    } catch {}
  };

  const togglePage = (pageId: string) => {
    if (isScanning) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(pageId) ? next.delete(pageId) : next.add(pageId);
      return next;
    });
  };

  const allSelected = pages.length > 0 && selectedIds.size === pages.length;
  const toggleAll = () => {
    if (isScanning) return;
    setSelectedIds(allSelected ? new Set() : new Set(pages.map(p => p.pageId)));
  };

  const scanProgress = activeJob ? activeJob.donePages + activeJob.failedPages + activeJob.skippedPages : 0;
  const scanTotal    = activeJob?.totalPages ?? 0;
  const progressPct  = scanTotal > 0 ? Math.round((scanProgress / scanTotal) * 100) : 0;

  const timeRemainingLabel = (() => {
    if (!scanStartRef.current || scanProgress === 0 || scanTotal === 0) return '';
    const elapsed = Date.now() - scanStartRef.current;
    const perPage = elapsed / scanProgress;
    const remaining = Math.round((scanTotal - scanProgress) * perPage / 1000);
    if (remaining <= 0) return '';
    if (remaining < 60) return `About ${remaining}s left`;
    return `About ${Math.round(remaining / 60)}m left`;
  })();

  /* ── Shared header ─────────────────────────────────────────────────────── */
  const header = (
    <header className="app-header">
      <div className="app-header-logo">
        <span className="app-header-icon">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l4 4 10-10"/>
          </svg>
        </span>
        <span className="app-header-title">Accessibility Scanner</span>
      </div>
      <div className="app-header-actions">
        <span className="status-pill status-pill--connected">
          <span className="status-pill-dot"/>
          {siteInfo?.siteName ?? 'Connected'}
        </span>
        <button className="btn-ghost" onClick={onHistory} aria-label="View scan history">
          History
        </button>
      </div>
    </header>
  );

  /* ── Scanning view ─────────────────────────────────────────────────────── */
  if (isScanning || (activeJob && activeJob.status === 'queued')) {
    const jobPages = activeJob?.pages ?? [];
    const currentPage = jobPages.find(p => p.status === 'running');
    const currentTitle = currentPage?.title ?? currentPage?.url ?? null;
    const currentUrl = currentPage?.url ?? null;

    return (
      <div className="scanner-screen">
        {header}
        <main className="scanning-main">
          <ScanRing done={scanProgress} total={scanTotal} />

          <div className="scanning-current">
            <h1 className="scanning-heading">
              {activeJob?.status === 'queued'
                ? 'Starting scan…'
                : currentTitle
                  ? <>Scanning <strong className="scanning-heading-accent">{currentTitle}</strong>…</>
                  : 'Scanning pages…'}
            </h1>
            {currentUrl && activeJob?.status !== 'queued' && (
              <div className="scanning-url">{currentUrl}</div>
            )}
          </div>

          <div className="scanning-progress-wrap">
            <div className="progress-track" style={{ height: 12 }}>
              <div
                className="progress-fill"
                style={{ width: `${progressPct}%` }}
              />
              {progressPct > 0 && progressPct < 100 && (
                <div className="progress-cursor" style={{ left: `calc(${progressPct}% - 2px)` }} />
              )}
            </div>
            <div className="progress-meta">
              <span>{progressPct}% complete</span>
              {activeJob?.failedPages > 0
                ? <span style={{ color: 'var(--red-text)' }}>{activeJob.failedPages} failed</span>
                : timeRemainingLabel
                  ? <span style={{ color: '#A49DB1' }}>{timeRemainingLabel}</span>
                  : null
              }
            </div>
          </div>

          {(jobPages.length > 0 || scanTotal > 0) && (
            <div className="scanning-queue">
              {jobPages.length === 0 && Array.from({ length: Math.min(scanTotal, 6) }).map((_, i) => (
                <div key={i} className="queue-row">
                  <span className="queue-status-icon"><span className="queue-icon-queued" /></span>
                  <span className="queue-page-name queue-page-name--skeleton">Loading…</span>
                  <span className="queue-page-status queue-page-status--queued">Queued</span>
                </div>
              ))}
              {jobPages.slice(0, 20).map(p => {
                let iconEl: React.ReactNode;
                let statusLabel: string;
                let statusClass: string;
                let rowClass = 'queue-row';
                switch (p.status) {
                  case 'done': {
                    iconEl = (
                      <span className="queue-icon-done">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12l4 4 10-10"/>
                        </svg>
                      </span>
                    );
                    const dur = p.durationMs ? ` · ${(p.durationMs / 1000).toFixed(1)}s` : '';
                    statusLabel = `Done${dur}`; statusClass = 'queue-page-status--done'; break;
                  }
                  case 'skipped':
                  case 'failed': {
                    const isPassword = p.status === 'skipped' && (p.error ?? '').toLowerCase().includes('password');
                    iconEl = isPassword ? (
                      <span className="queue-icon-skip">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                      </span>
                    ) : (
                      <span className="queue-icon-skip">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                      </span>
                    );
                    statusLabel = p.status === 'failed' ? 'Failed' : 'Skipped';
                    statusClass = p.status === 'failed' ? 'queue-page-status--failed' : 'queue-page-status--skip'; break;
                  }
                  case 'running':
                    iconEl = <span className="queue-icon-scanning queue-icon-scanning--purple" aria-label="Scanning" />;
                    statusLabel = 'Scanning…'; statusClass = 'queue-page-status--active';
                    rowClass = 'queue-row queue-row--active'; break;
                  default:
                    iconEl = <span className="queue-icon-queued" />;
                    statusLabel = 'Queued'; statusClass = 'queue-page-status--queued';
                }
                return (
                  <div key={p.pageId} className={rowClass}>
                    <span className="queue-status-icon">{iconEl}</span>
                    <span className="queue-page-name">{p.title || p.url}</span>
                    <span className={`queue-page-status ${statusClass}`}>{statusLabel}</span>
                  </div>
                );
              })}
            </div>
          )}

          <button className="btn-cancel" onClick={cancelScan}>
            Cancel scan
          </button>
        </main>
        <footer className="app-footer">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>
          </svg>
          You can keep working in Webflow — the scan continues in the background.
        </footer>
      </div>
    );
  }

  /* ── Page selector view ────────────────────────────────────────────────── */
  return (
    <div className="scanner-screen">
      {header}

      <main className="scanner-main">
        <div className="scanner-section-label">
          <span className="scanner-section-label-dots">
            <span style={{ background: 'var(--green)' }}/>
            <span style={{ background: 'var(--purple)' }}/>
          </span>
          SITE-WIDE AUDIT
        </div>

        <h1 className="scanner-heading">
          Scan <strong className="scanner-heading-accent">{siteInfo?.siteName ?? 'your site'}</strong> for accessibility issues
        </h1>
        <p className="scanner-subheading">Checks every published page against WCAG 2.1 / 2.2 A &amp; AA rules, plus best-practice checks.</p>

        {pagesLoading && (
          <div className="scanner-state-box">
            <span className="scanner-spinner" aria-label="Loading pages" />
            Loading pages…
          </div>
        )}

        {pagesError && (
          <div className="scanner-error-box">
            <svg className="scanner-error-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 7v5M12 16h.01"/>
            </svg>
            <span>{pagesError}</span>
            <button className="btn-ghost" onClick={fetchPages} style={{ marginLeft: 'auto', flexShrink: 0 }}>Retry</button>
          </div>
        )}

        {!pagesLoading && !pagesError && pages.length > 0 && (
          <div className="pages-panel">
            <div className="pages-panel-header">
              <div className="pages-panel-header-left">
                <input
                  type="checkbox"
                  className="page-checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={allSelected ? 'Deselect all pages' : 'Select all pages'}
                />
                <span className="pages-panel-title">PAGES TO SCAN</span>
              </div>
              <span className="pages-count-badge">
                <span className="pages-count-selected">{selectedIds.size} / {pages.length} selected</span>
              </span>
            </div>
            <div className="pages-list">
              {pages.map(p => {
                const checked = selectedIds.has(p.pageId);
                return (
                  <label
                    key={p.pageId}
                    className="page-row"
                    onClick={() => togglePage(p.pageId)}
                  >
                    <input
                      type="checkbox"
                      className="page-checkbox"
                      checked={checked}
                      onChange={() => togglePage(p.pageId)}
                      aria-label={`Select ${p.title}`}
                    />
                    <span className="page-title">{p.title}</span>
                    {p.path && <span className="page-path">{p.path}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {scanError && (
          <div className="scanner-error-box">
            <svg className="scanner-error-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 7v5M12 16h.01"/>
            </svg>
            <span>{scanError}</span>
          </div>
        )}

        {!pagesLoading && !pagesError && pages.length > 0 && (
          <div className="scanner-cta-wrap">
            <button
              className="btn-primary"
              onClick={startScan}
              disabled={!selectedIds.size || isScanning || scanLoading}
            >
              {scanLoading ? (
                <>
                  <span className="scanner-cta-spinner" />
                  Starting…
                </>
              ) : (
                <>
                  Scan {selectedIds.size} page{selectedIds.size !== 1 ? 's' : ''}
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                </>
              )}
            </button>
            <div className="scanner-cta-note scanner-cta-note--center">
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>
              </svg>
              Scan runs in the background — you can close this panel any time.
            </div>
          </div>
        )}
      </main>

      <footer className="app-footer app-footer--empty" />
    </div>
  );
};

export default ScannerScreen;
