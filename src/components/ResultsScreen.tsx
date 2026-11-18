import React, { useState } from 'react';
import { ScanResult } from './ScannerScreen';
import '../styles/resultsscreen.css';

interface Props {
  results: ScanResult[];
  pageUrl: string;
  pageTitle?: string;
  pageScore?: number;
  onBack: () => void;
  onRescan: () => void;
}

type TabFilter = 'all' | 'serious' | 'moderate';

function sevChipClass(impact: string): string {
  if (impact === 'critical' || impact === 'serious') return 'sev-chip--serious';
  if (impact === 'moderate') return 'sev-chip--moderate';
  return 'sev-chip--minor';
}

function sevLabel(impact: string): string {
  switch (impact) {
    case 'critical': return 'Critical';
    case 'serious':  return 'Serious';
    case 'moderate': return 'Moderate';
    default:         return 'Minor';
  }
}

interface RuleGroup {
  rule: string;
  impact: string;
  message: string;
  howToFix: string;
  helpUrl: string;
  wcag: string;
  level: string;
  issues: ScanResult[];
}

function groupByRule(issues: ScanResult[]): RuleGroup[] {
  const map = new Map<string, RuleGroup>();
  for (const issue of issues) {
    if (!map.has(issue.rule)) {
      map.set(issue.rule, {
        rule: issue.rule,
        impact: issue.impact,
        message: issue.message,
        howToFix: issue.howToFix,
        helpUrl: issue.helpUrl,
        wcag: issue.wcag || '',
        level: issue.level || '',
        issues: [],
      });
    }
    map.get(issue.rule)!.issues.push(issue);
  }
  const order = ['critical', 'serious', 'moderate', 'minor'];
  return [...map.values()].sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact));
}

function scoreStatus(score: number): { label: string; color: string } {
  if (score >= 80) return { label: 'Great', color: 'var(--green)' };
  if (score >= 50) return { label: 'Needs work', color: 'var(--yellow)' };
  return { label: 'Needs work', color: 'var(--red-text)' };
}

const ScoreRing: React.FC<{ score: number }> = ({ score }) => {
  const r = 22;
  const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  const color = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--red-text)';
  const status = scoreStatus(score);
  return (
    <div className="page-score-wrap">
      <div className="page-score-meta">
        <span className="page-score-label">PAGE SCORE</span>
        <span className="page-score-status" style={{ color: status.color }}>{status.label}</span>
      </div>
      <div className="page-score-ring">
        <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
          <circle cx="28" cy="28" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
          <circle cx="28" cy="28" r={r} fill="none" stroke={color} strokeWidth="5"
            strokeLinecap="round" strokeDasharray={`${fill} ${circ}`}
            transform="rotate(-90 28 28)"
          />
        </svg>
        <div className="page-score-ring-label">
          <span className="page-score-ring-num" style={{ color }}>{score}</span>
        </div>
      </div>
    </div>
  );
};

function sevBorderColor(impact: string): string {
  if (impact === 'critical' || impact === 'serious') return 'rgba(255,107,122,0.28)';
  if (impact === 'moderate') return 'rgba(245,196,81,0.28)';
  return 'rgba(255,255,255,0.08)';
}

const IssueGroup: React.FC<{ group: RuleGroup }> = ({ group }) => {
  const [open, setOpen] = useState(false);
  const [elemIdx, setElemIdx] = useState(0);

  const issue = group.issues[elemIdx];
  const totalElems = group.issues.length;

  const copySelector = () => {
    if (issue?.target) {
      try { navigator.clipboard.writeText(issue.target); } catch {}
    }
  };

  const complianceTag = '';

  return (
    <div className="issue-group" style={{ borderColor: open ? sevBorderColor(group.impact) : undefined }}>
      <button
        type="button"
        className="issue-group-header"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <div className="issue-group-info">
          <div className="issue-group-top">
            <span className={`sev-chip ${sevChipClass(group.impact)}`}>
              <span className="sev-chip-dot"/>
              {sevLabel(group.impact)}
            </span>
            {group.rule && (
              <span className="issue-group-rule">{group.rule}</span>
            )}
            {complianceTag && (
              <span className="issue-wcag-tag">{complianceTag}</span>
            )}
          </div>
          <div className="issue-group-title-row">
            <span className="issue-group-title">{group.message}</span>
            <span className="issue-elem-count">{totalElems} element{totalElems !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <svg className={`issue-group-chevron ${open ? 'issue-group-chevron--open' : ''}`} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {open && (
        <div className="issue-detail">

          {totalElems > 0 && (
            <div className="issue-elem-nav">
              <span className="issue-elem-nav-label">Element {elemIdx + 1} of {totalElems}</span>
              <div className="issue-elem-nav-btns">
                <button type="button" className="issue-nav-btn" onClick={() => setElemIdx(i => Math.max(0, i - 1))} disabled={elemIdx === 0} aria-label="Previous element">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
                </button>
                <button type="button" className="issue-nav-btn" onClick={() => setElemIdx(i => Math.min(totalElems - 1, i + 1))} disabled={elemIdx === totalElems - 1} aria-label="Next element">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
                </button>
              </div>
            </div>
          )}

          {issue?.target && (
            <div className="issue-code-block">
              <pre className="issue-code-pre">{issue.target}</pre>
            </div>
          )}

          {group.howToFix && (
            <div className="issue-fix-card">
              <div className="issue-fix-card-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                </svg>
                How to fix
              </div>
              <p className="issue-fix-card-body">{group.howToFix}</p>
            </div>
          )}

          <div className="issue-actions">
            {issue?.target && (
              <button type="button" className="issue-action-btn" onClick={copySelector}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                Copy selector
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const ResultsScreen: React.FC<Props> = ({ results, pageUrl, pageTitle, pageScore, onBack, onRescan }) => {
  const [tab, setTab] = useState<TabFilter>('all');

  const filtered = results.filter(r => {
    if (tab === 'all') return true;
    if (tab === 'serious') return r.impact === 'critical' || r.impact === 'serious';
    return r.impact === 'moderate';
  });

  const groups = groupByRule(filtered);
  const seriousCount  = results.filter(r => r.impact === 'critical' || r.impact === 'serious').length;
  const moderateCount = results.filter(r => r.impact === 'moderate').length;

  const score = pageScore ?? Math.max(0, 100
    - results.filter(r => r.impact === 'critical').length * 10
    - results.filter(r => r.impact === 'serious').length * 5
    - results.filter(r => r.impact === 'moderate').length * 2
    - results.filter(r => r.impact === 'minor').length);

  let urlPath = pageUrl;
  try { urlPath = new URL(pageUrl).pathname || pageUrl; } catch {}

  const tabs = [
    { key: 'all' as TabFilter,      label: 'All',      count: results.length,  inactiveColor: '' },
    { key: 'serious' as TabFilter,  label: 'Serious',  count: seriousCount,    inactiveColor: 'var(--red-text)' },
    { key: 'moderate' as TabFilter, label: 'Moderate', count: moderateCount,   inactiveColor: 'var(--yellow)' },
  ];

  return (
    <div className="results-screen">

      <header className="results-header">
        <button className="results-back-btn" onClick={onBack} aria-label="Back to all pages">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 6l-6 6 6 6"/>
          </svg>
        </button>

        <div className="results-header-info">
          <div className="results-header-breadcrumb">All pages /</div>
          <div className="results-header-page">{pageTitle || urlPath}</div>
          {pageTitle && <div className="results-header-path">{urlPath}</div>}
        </div>

        <ScoreRing score={score} />
      </header>

      <nav className="results-tabs-wrap" aria-label="Filter issues">
        <div className="results-filter-row">
          <div className="results-tabs-pill">
            {tabs.map(t => (
              <button
                key={t.key}
                className={`results-tab ${tab === t.key ? 'results-tab--active' : ''}`}
                style={tab !== t.key && t.inactiveColor ? { color: t.inactiveColor } : undefined}
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
              >
                {t.label}
                <span className="results-tab-sep">·</span>
                <span className="results-tab-num">{t.count}</span>
              </button>
            ))}
          </div>
          <span className="results-grouped-label">Grouped by rule</span>
        </div>
      </nav>

      <div className="results-body">
        {groups.length === 0 ? (
          <div className="results-empty">
            <div className="results-empty-icon">
              <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l4 4 10-10"/>
              </svg>
            </div>
            <strong>No issues found</strong>
            <span style={{ fontSize: 13 }}>This page passed all checks in this category.</span>
          </div>
        ) : (
          (() => {
            const rows: React.ReactNode[] = [];
            let lastSev = '';
            const sevHeadingColor = (impact: string) => {
              if (impact === 'critical' || impact === 'serious') return 'var(--red-text)';
              if (impact === 'moderate') return 'var(--yellow)';
              return 'var(--dim)';
            };
            const sevHeadingDot = (impact: string) => {
              if (impact === 'critical' || impact === 'serious') return 'var(--red)';
              if (impact === 'moderate') return 'var(--yellow)';
              return 'var(--dim)';
            };
            const sevHeadingLabel = (impact: string) => {
              if (impact === 'critical' || impact === 'serious') return 'SERIOUS';
              if (impact === 'moderate') return 'MODERATE';
              return 'MINOR';
            };
            const normalizedSev = (impact: string) =>
              (impact === 'critical' || impact === 'serious') ? 'serious' : impact;

            for (const g of groups) {
              const ns = normalizedSev(g.impact);
              if (ns !== lastSev) {
                const count = groups.filter(x => normalizedSev(x.impact) === ns)
                  .reduce((n, x) => n + x.issues.length, 0);
                rows.push(
                  <div key={`hd-${ns}`} className="sev-section-heading" style={{ color: sevHeadingColor(g.impact) }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: sevHeadingDot(g.impact), flexShrink: 0, display: 'inline-block' }} />
                    {sevHeadingLabel(g.impact)} · {count}
                  </div>
                );
                lastSev = ns;
              }
              rows.push(<IssueGroup key={g.rule} group={g} />);
            }
            return rows;
          })()
        )}
      </div>

      <footer className="app-footer">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>
        </svg>
        Automated checks find roughly 30–50% of issues. Test keyboard, screen readers and alt text by hand.
      </footer>
    </div>
  );
};

export default ResultsScreen;
