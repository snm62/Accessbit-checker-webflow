import React, { useEffect, useState } from 'react';
import { ScanResult } from './ScannerScreen';
import '../styles/historyscreen.css';

interface ScanSummary {
  total: number;
  score: number;
  byCritical: number;
  bySerious: number;
  byModerate: number;
  byMinor: number;
}

interface HistoryEntry {
  scanId: string | null;
  pageUrl: string;
  scannedAt: string;
  durationMs: number;
  summary: ScanSummary | null;
  status?: string;   // 'done' | 'failed' | 'skipped' | 'running' | 'queued'
  error?: string | null;
}

interface FullScan extends HistoryEntry {
  issues: ScanResult[];
  passesCount: number;
  incompleteCount: number;
}

interface Props {
  makeAuthRequest: (path: string, init?: RequestInit) => Promise<Response>;
  onBack: () => void;
  onViewScan: (issues: ScanResult[], pageUrl: string) => void;
}

const CIRC = 2 * Math.PI * 18;

function scorePillStyle(score: number): React.CSSProperties {
  if (score >= 80) return { background: 'rgba(198,244,50,0.12)', color: '#C6F432' };
  if (score >= 50) return { background: 'rgba(245,196,81,0.14)', color: '#F5C451' };
  return { background: 'rgba(255,107,122,0.14)', color: '#FF8F9B' };
}

function formatScanDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'short' });
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} · ${hh}:${mm}`;
}

function formatDuration(ms: number): string {
  if (!ms) return '';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function pageLabel(url: string): string {
  try {
    const path = new URL(url).pathname;
    if (path === '/' || path === '') return 'Home';
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1]
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch { return url; }
}

function pagePath(url: string): string {
  try { return new URL(url).pathname; }
  catch { return url; }
}

function siteHostname(url: string): string {
  try { return new URL(url).hostname; }
  catch { return ''; }
}

function pageStatusLabel(entry: HistoryEntry): string | null {
  const s = entry.status ?? 'done';
  if (s === 'done') return null;
  if (s === 'skipped') {
    const e = (entry.error ?? '').toLowerCase();
    if (e.includes('password')) return 'Password protected';
    if (e.includes('redirect')) return 'Redirected';
    return 'Skipped';
  }
  if (s === 'failed') return entry.error ? `Failed: ${entry.error}` : 'Failed';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ScoreRing: React.FC<{ score: number; isLatest: boolean }> = ({ score, isLatest }) => {
  const fill = (score / 100) * CIRC;
  const id = `hg-${score}-${isLatest ? 1 : 0}`;
  return (
    <span style={{ position: 'relative', width: 44, height: 44, flexShrink: 0, display: 'inline-flex' }}>
      <svg aria-hidden="true" width="44" height="44" viewBox="0 0 44 44">
        {isLatest && (
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#B26BFF" />
              <stop offset="1" stopColor="#C6F432" />
            </linearGradient>
          </defs>
        )}
        <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
        <circle cx="22" cy="22" r="18" fill="none"
          stroke={isLatest ? `url(#${id})` : '#6B6478'}
          strokeWidth="4" strokeLinecap="round"
          strokeDasharray={`${fill.toFixed(1)} ${CIRC.toFixed(1)}`}
          transform="rotate(-90 22 22)"
        />
      </svg>
      <span style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 700, color: isLatest ? '#F4F2F7' : '#A49DB1',
      }}>{score}</span>
    </span>
  );
};

interface ScanGroup { scannedAt: string; pages: HistoryEntry[]; }

const HistoryScreen: React.FC<Props> = ({ makeAuthRequest, onBack, onViewScan }) => {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [openIdx, setOpenIdx] = useState<number>(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => { fetchHistory(); }, []);

  async function fetchHistory(after?: string) {
    if (after) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const path = after ? `/api/scanner/history?after=${encodeURIComponent(after)}` : '/api/scanner/history';
      const res = await makeAuthRequest(path);
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json() as { entries: HistoryEntry[]; next?: string };
      setEntries(prev => after ? [...prev, ...data.entries] : data.entries);
      setHasMore(!!data.next);
      setCursor(data.next ?? null);
    } catch (err: any) {
      setError(err.message || 'Failed to load history.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  async function handleViewPage(scanId: string) {
    setLoadingId(scanId);
    try {
      const res = await makeAuthRequest(`/api/scanner/history/${scanId}`);
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const scan: FullScan = await res.json();
      onViewScan(scan.issues ?? [], scan.pageUrl);
    } catch {}
    finally { setLoadingId(null); }
  }

  // Group entries by minute-truncated scannedAt to handle per-page timestamps
  const groupMap: Record<string, HistoryEntry[]> = {};
  for (const e of entries) {
    const key = e.scannedAt.substring(0, 16); // "2024-01-15T14:23"
    if (!groupMap[key]) groupMap[key] = [];
    groupMap[key].push(e);
  }
  const groups: ScanGroup[] = Object.entries(groupMap)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([, pages]) => ({ scannedAt: pages[0].scannedAt, pages }));

  const site = entries.length > 0 ? siteHostname(entries[0].pageUrl) : '';
  const INITIAL_COUNT = 3;
  const visibleGroups = showAll ? groups : groups.slice(0, INITIAL_COUNT);
  const hasHiddenGroups = !showAll && groups.length > INITIAL_COUNT;

  return (
    <div className="history-screen">
      <header className="history-header">
        <button className="btn-back" onClick={onBack} aria-label="Back">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 6l-6 6 6 6"/>
          </svg>
        </button>
        <div className="history-header-info">
          <span className="history-header-title">Scan history</span>
          {site && <span className="history-header-sub">{site} · Last 50 scans · Kept 30 days</span>}
        </div>
        {site && (
          <span className="history-site-pill">
            <span className="history-site-dot" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{site}</span>
          </span>
        )}
      </header>

      <div className="history-body">
        {loading && (
          <div className="history-state-box">
            <span className="history-spinner" aria-label="Loading" />
            Loading history…
          </div>
        )}

        {error && !loading && (
          <div className="history-state-box" style={{ color: 'var(--red-text)' }}>
            {error}
            <button className="btn-ghost" onClick={() => fetchHistory()} style={{ marginTop: 8 }}>Retry</button>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="history-state-box">
            <svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
            </svg>
            No scans yet. Run your first scan to see history here.
          </div>
        )}

        {visibleGroups.map((group, gi) => {
          const isLatest = gi === 0;
          const isOpen = openIdx === gi;
          const scannedPages = group.pages.filter(p => (p.status ?? 'done') === 'done' && p.summary);
          const avgScore = scannedPages.length > 0
            ? Math.round(scannedPages.reduce((n, p) => n + (p.summary!.score ?? 0), 0) / scannedPages.length)
            : 0;
          const totalIssues = scannedPages.reduce((n, p) => n + (p.summary?.total ?? 0), 0);
          const totalDuration = group.pages.reduce((n, p) => n + (p.durationMs ?? 0), 0);
          const dur = formatDuration(totalDuration);

          return (
            <section key={group.scannedAt} className="history-scan-card" aria-label={`Scan on ${formatScanDate(group.scannedAt)}`}>
              <button
                type="button"
                className={`history-card-hd${isLatest ? ' history-card-hd--latest' : ''}`}
                onClick={() => setOpenIdx(isOpen ? -1 : gi)}
                aria-expanded={isOpen}
              >
                <ScoreRing score={avgScore} isLatest={isLatest} />
                <span className="history-card-info">
                  <span className="history-card-date">
                    {formatScanDate(group.scannedAt)}
                    {isLatest && <span className="history-latest-badge">Latest</span>}
                  </span>
                  <span className="history-card-meta">
                    {scannedPages.length} page{scannedPages.length !== 1 ? 's' : ''} · {totalIssues} issue{totalIssues !== 1 ? 's' : ''}
                    {dur ? ` · ${dur}` : ''}
                  </span>
                </span>
                <svg aria-hidden="true" className={`history-chevron${isOpen ? ' history-chevron--up' : ''}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A49DB1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>

              {isOpen && (
                <div className="history-card-pages">
                  {group.pages.map((p, pi) => {
                    const isScanned = (p.status ?? 'done') === 'done' && p.scanId;
                    const reasonLabel = pageStatusLabel(p);
                    return (
                      <button
                        key={p.scanId ?? `${p.pageUrl}-${pi}`}
                        type="button"
                        className={`history-page-row${pi === group.pages.length - 1 ? ' history-page-row--last' : ''}${!isScanned ? ' history-page-row--unscanned' : ''}`}
                        onClick={() => isScanned ? handleViewPage(p.scanId!) : undefined}
                        disabled={!isScanned || loadingId === p.scanId}
                        style={!isScanned ? { cursor: 'default' } : undefined}
                      >
                        <span className="history-page-label">
                          <span className="history-page-name">{pageLabel(p.pageUrl)}</span>
                          <span className="history-page-path">{pagePath(p.pageUrl)}</span>
                        </span>
                        {isScanned ? (
                          <>
                            <span className="history-page-issues">{p.summary?.total ?? 0} issues</span>
                            <span className="history-score-pill" style={scorePillStyle(p.summary?.score ?? 0)}>
                              {p.summary?.score ?? '—'}
                            </span>
                            {loadingId === p.scanId
                              ? <span className="history-page-spinner" />
                              : (
                                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8C8599" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M9 6l6 6-6 6"/>
                                </svg>
                              )
                            }
                          </>
                        ) : (
                          <span className="history-page-reason">{reasonLabel}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

        {hasHiddenGroups && (
          <button
            type="button"
            className="history-load-more-btn"
            onClick={() => setShowAll(true)}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
            </svg>
            Load older scans
          </button>
        )}

        {!hasHiddenGroups && hasMore && (
          <button
            type="button"
            className="history-load-more-btn"
            onClick={() => cursor && fetchHistory(cursor)}
            disabled={loadingMore}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
            </svg>
            {loadingMore ? 'Loading…' : 'Load older scans'}
          </button>
        )}
      </div>

      <footer className="app-footer">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>
        </svg>
        Scans are grouped by run. Open any page to see its issues from that scan.
      </footer>
    </div>
  );
};

export default HistoryScreen;
