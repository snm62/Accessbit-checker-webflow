import React, { useState, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import WelcomeScreen from './components/WelcomeScreen';
import ScannerScreen, { PageScanResult } from './components/ScannerScreen';
import SiteResultsScreen from './components/SiteResultsScreen';
import HistoryScreen from './components/HistoryScreen';

declare const webflow: { setExtensionSize: (s: any) => Promise<null> };

type Screen = 'welcome' | 'scanner' | 'site-results' | 'history';

function hasStoredAuth(): boolean {
  try {
    const raw = localStorage.getItem('accessibility-checker-siteinfo');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.siteId);
  } catch { return false; }
}

const App: React.FC = () => {
  const { isAuthenticated, isLoading, siteInfo, authorize, makeAuthRequest, logout } = useAuth();
  const [screen, setScreen] = useState<Screen>(() => hasStoredAuth() ? 'scanner' : 'welcome');
  const [siteResults, setSiteResults] = useState<PageScanResult[] | null>(null);
  const [scanDurationMs, setScanDurationMs] = useState<number | undefined>(undefined);

  useEffect(() => {
    try { webflow.setExtensionSize('large'); } catch {}
  }, []);

  useEffect(() => {
    if (isAuthenticated && screen === 'welcome') {
      setScreen('scanner');
    }
  }, [isAuthenticated]);

  const handleScanComplete = (results: PageScanResult[], meta?: { durationMs: number }) => {
    setSiteResults(results);
    setScanDurationMs(meta?.durationMs);
    setScreen('site-results');
  };

  const handleLogout = () => {
    logout();
    setScreen('welcome');
  };

  if (screen === 'welcome' || !isAuthenticated) {
    if (isLoading) return null;
    return (
      <WelcomeScreen
        isLoading={isLoading}
        isAuthenticated={isAuthenticated}
        siteName={siteInfo?.siteName}
        onAuthorize={authorize}
        onContinue={() => setScreen('scanner')}
      />
    );
  }

  if (screen === 'site-results' && siteResults) {
    return (
      <SiteResultsScreen
        results={siteResults}
        siteName={siteInfo?.siteName ?? ''}
        scanDurationMs={scanDurationMs}
        onRescan={() => setScreen('scanner')}
        onHistory={() => setScreen('history')}
      />
    );
  }

  if (screen === 'history') {
    return (
      <HistoryScreen
        makeAuthRequest={makeAuthRequest}
        onBack={() => setScreen('scanner')}
        onViewScan={(issues, pageUrl) => {
          // History still shows single-page results for now — wrap in a PageScanResult
          setSiteResults([{
            page: { pageId: '', title: pageUrl, slug: '', path: '', url: pageUrl, isCmsTemplate: false, collectionId: null, parentId: null },
            issues,
            summary: {
              total: issues.length,
              accessibility: issues.filter(i => i.category === 'accessibility').length,
              bestPractice: issues.filter(i => i.category === 'best-practice').length,
              byCritical: issues.filter(i => i.impact === 'critical').length,
              bySerious: issues.filter(i => i.impact === 'serious').length,
              byModerate: issues.filter(i => i.impact === 'moderate').length,
              byMinor: issues.filter(i => i.impact === 'minor').length,
              score: Math.max(0, 100 - issues.filter(i => i.impact === 'critical').length * 10 - issues.filter(i => i.impact === 'serious').length * 5 - issues.filter(i => i.impact === 'moderate').length * 2 - issues.filter(i => i.impact === 'minor').length),
            },
            scannedAt: new Date().toISOString(),
            durationMs: 0,
          }]);
          setScreen('site-results');
        }}
      />
    );
  }

  return (
    <ScannerScreen
      siteInfo={siteInfo}
      onScanComplete={handleScanComplete}
      makeAuthRequest={makeAuthRequest}
      onLogout={handleLogout}
      onHistory={() => setScreen('history')}
    />
  );
};

export default App;
