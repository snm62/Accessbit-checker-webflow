import React, { useState } from 'react';
import { PageScanResult } from './ScannerScreen';
import ResultsScreen from './ResultsScreen';
import '../styles/siteresultsscreen.css';

interface Props {
  results: PageScanResult[];
  siteName: string;
  scanDurationMs?: number;
  isScanning?: boolean;
  onBack: () => void;
  onRescan: () => void;
  onHistory: () => void;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function scoreColor(score: number): string {
  if (score >= 80) return 'var(--green)';
  if (score >= 50) return 'var(--yellow)';
  return 'var(--red)';
}

function totalIssues(results: PageScanResult[]): number {
  return results.reduce((n, r) => n + (r.summary?.total ?? 0), 0);
}

function avgScore(results: PageScanResult[]): number {
  const valid = results.filter(r => !r.error && !r.skipped);
  if (!valid.length) return 0;
  return Math.round(valid.reduce((n, r) => n + (r.summary?.score ?? 0), 0) / valid.length);
}

/* Large score ring — gradient purple→green */
const ScoreRing: React.FC<{ score: number }> = ({ score }) => {
  const size = 120;
  const r = 48;
  const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  return (
    <div className="site-score-ring">
      <svg width={size} height={size} viewBox="0 0 112 112" aria-hidden="true">
        <defs>
          <linearGradient id="resGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--purple)" />
            <stop offset="100%" stopColor="var(--green)" />
          </linearGradient>
        </defs>
        <circle cx="56" cy="56" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="8" />
        <circle cx="56" cy="56" r={r} fill="none" stroke="url(#resGrad)" strokeWidth="8"
          strokeLinecap="round" strokeDasharray={`${fill} ${circ}`}
          transform="rotate(-90 56 56)"
          style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
      </svg>
      <div className="site-score-ring-label">
        <span className="site-score-ring-num">{score}</span>
        <span className="site-score-ring-sub">SCORE</span>
      </div>
    </div>
  );
};

/* Mini ring for per-page rows (38px) */
const MiniRing: React.FC<{ score: number; failed?: boolean }> = ({ score, failed }) => {
  const color = failed ? 'var(--red)' : scoreColor(score);
  const r = 15;
  const circ = 2 * Math.PI * r;
  const fill = failed ? 0 : (score / 100) * circ;
  return (
    <div className="site-mini-ring">
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
        <circle cx="19" cy="19" r={r} fill="none"
          stroke={failed ? 'rgba(255,107,122,0.2)' : 'rgba(255,255,255,0.08)'}
          strokeWidth="4" />
        {!failed && (
          <circle cx="19" cy="19" r={r} fill="none" stroke={color} strokeWidth="4"
            strokeLinecap="round" strokeDasharray={`${fill} ${circ}`}
            transform="rotate(-90 19 19)"
          />
        )}
      </svg>
      <span className="site-mini-ring-num" style={{ color }}>{failed ? '!' : score}</span>
    </div>
  );
};

function formatDurMs(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/* ── Main component ─────────────────────────────────────────────────────── */
const SiteResultsScreen: React.FC<Props> = ({ results, siteName, scanDurationMs, isScanning, onBack, onRescan, onHistory }) => {
  const [selectedPageUrl, setSelectedPageUrl] = useState<string | null>(null);

  const score    = avgScore(results);
  const total    = totalIssues(results);
  const serious  = results.reduce((n, r) => n + (r.summary?.bySerious ?? 0) + (r.summary?.byCritical ?? 0), 0);
  const moderate = results.reduce((n, r) => n + (r.summary?.byModerate ?? 0), 0);
  const skipped  = results.filter(r => r.skipped).length;
  const scanned  = results.filter(r => !r.skipped && !r.error).length;

  const seriousPct  = total > 0 ? (serious / total) * 100 : 0;
  const moderatePct = total > 0 ? (moderate / total) * 100 : 0;

  /* Sorted pages: errors/skipped last, then by most issues */
  const sorted = [...results].sort((a, b) => {
    const aSkip = a.skipped || a.error ? 1 : 0;
    const bSkip = b.skipped || b.error ? 1 : 0;
    if (aSkip !== bSkip) return aSkip - bSkip;
    return (b.summary?.total ?? 0) - (a.summary?.total ?? 0);
  });

  /* Drill down into page detail */
  if (selectedPageUrl) {
    const entry = results.find(r => r.page.url === selectedPageUrl);
    if (entry) {
      return (
        <ResultsScreen
          results={entry.issues}
          pageUrl={entry.page.url}
          pageTitle={entry.page.title}
          pageScore={entry.summary?.score}
          onBack={() => setSelectedPageUrl(null)}
          onRescan={onRescan}
        />
      );
    }
  }

  return (
    <div className="site-results-screen">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="site-results-header">
        <button className="btn-back" onClick={onBack} aria-label="Back">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 6l-6 6 6 6"/>
          </svg>
        </button>
        <div className="site-results-header-info">
          <span className="site-results-header-title">Audit results</span>
          <span className="site-results-header-meta">
            <span className="site-results-header-dot" />
            {siteName}
            {scanDurationMs
              ? <span style={{ color: '#A49DB1' }}> · Just now · {formatDurMs(scanDurationMs)}</span>
              : null}
          </span>
        </div>
        <div className="site-results-header-actions">
          <button className="btn-ghost" onClick={onHistory}>History</button>
          <button
            className="btn-rescan"
            onClick={onRescan}
            disabled={isScanning}
            title={isScanning ? 'A scan is currently in progress' : undefined}
            style={isScanning ? { opacity: 0.45, cursor: 'not-allowed', pointerEvents: 'none' } : undefined}
          >
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>
            </svg>
            Rescan
          </button>
        </div>
      </header>

      <main className="site-results-main">

        {/* ── Score card ────────────────────────────────────────────────── */}
        <section className="site-score-card" aria-label="Site score">
          <ScoreRing score={score} />
          <div className="site-score-info">
            <div className="site-score-headline">
              <span className="site-score-issues">{total} issue{total !== 1 ? 's' : ''}</span>
              <span className="site-score-subtext">
                across {scanned} page{scanned !== 1 ? 's' : ''}{skipped > 0 ? ` · ${skipped} skipped` : ''}
              </span>
            </div>
            {total > 0 && (
              <div className="site-score-bar">
                {serious > 0 && <div className="site-score-bar-serious" style={{ width: `${seriousPct}%` }} />}
                {moderate > 0 && <div className="site-score-bar-moderate" style={{ flex: 1 }} />}
              </div>
            )}
            <div className="site-score-chips">
              {serious > 0 && (
                <span className="site-chip site-chip--serious">
                  <span className="site-chip-dot" />
                  {serious} Serious
                </span>
              )}
              {moderate > 0 && (
                <span className="site-chip site-chip--moderate">
                  <span className="site-chip-dot" />
                  {moderate} Moderate
                </span>
              )}
            </div>
          </div>
        </section>

        {/* ── Pages header row ──────────────────────────────────────────── */}
        <div className="site-pages-header">
          <span className="site-pages-label">PAGES</span>
          <span className="site-pages-sort">Sorted by most issues</span>
        </div>

        {/* ── Pages list ────────────────────────────────────────────────── */}
        <section className="site-pages-card" aria-label="Pages">
          {sorted.map((r, idx) => {
            const pg = r.page;
            const pgScore = r.summary?.score ?? 0;
            const pgTotal = r.summary?.total ?? 0;
            const pgSerious = (r.summary?.bySerious ?? 0) + (r.summary?.byCritical ?? 0);
            const pgModerate = r.summary?.byModerate ?? 0;
            const isLast = idx === sorted.length - 1;

            if (r.skipped) {
              return (
                <div key={pg.pageId} className={`site-page-row site-page-row--skipped${isLast ? ' site-page-row--last' : ''}`}>
                  <span className="site-page-skipped-icon">
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>
                    </svg>
                  </span>
                  <span className="site-page-info">
                    <span className="site-page-title">{pg.title || pg.url}</span>
                    <span className="site-page-path">{pg.path || pg.url}</span>
                  </span>
                  <span className="site-page-skipped-label">Skipped · {r.skipped === 'password-protected' ? 'password protected' : r.skipped}</span>
                </div>
              );
            }

            if (r.error) {
              return (
                <div key={pg.pageId} className={`site-page-row site-page-row--error${isLast ? ' site-page-row--last' : ''}`}>
                  <MiniRing score={0} failed />
                  <span className="site-page-info">
                    <span className="site-page-title">{pg.title || pg.url}</span>
                    <span className="site-page-path">{r.error}</span>
                  </span>
                </div>
              );
            }

            return (
              <button
                key={pg.pageId}
                className={`site-page-row site-page-row--link${isLast ? ' site-page-row--last' : ''}`}
                onClick={() => setSelectedPageUrl(pg.url)}
              >
                <MiniRing score={pgScore} />
                <span className="site-page-info">
                  <span className="site-page-title">{pg.title}</span>
                  <span className="site-page-path">{pg.path || pg.url}</span>
                </span>
                <span className="site-page-counts">
                  <span className="site-page-count-num" style={{ color: pgSerious > 0 ? 'var(--red-text)' : 'var(--text)' }}>{pgTotal}</span>
                  <span className="site-page-count-sub">
                    {pgSerious > 0 && pgModerate > 0
                      ? `${pgSerious} serious · ${pgModerate} moderate`
                      : pgSerious > 0
                        ? `${pgSerious} serious`
                        : `issues`}
                  </span>
                </span>
                <svg className="site-page-chevron" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6"/>
                </svg>
              </button>
            );
          })}
        </section>

      </main>

      <footer className="app-footer">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>
        </svg>
        Automated checks find roughly 30–50% of issues. Test keyboard, screen readers and alt text by hand.
      </footer>
    </div>
  );
};

export default SiteResultsScreen;
