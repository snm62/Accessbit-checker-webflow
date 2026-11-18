import React from 'react';
import '../styles/welcomescreen.css';

interface Props {
  isLoading: boolean;
  isAuthenticated: boolean;
  siteName?: string;
  onAuthorize: () => void;
  onContinue: () => void;
}

const WelcomeScreen: React.FC<Props> = ({ isLoading, isAuthenticated, siteName, onAuthorize, onContinue }) => {
  const isConnected = isAuthenticated && !!siteName;

  const handleClick = () => {
    if (isLoading) return;
    isAuthenticated ? onContinue() : onAuthorize();
  };

  return (
    <div className="welcome-screen">
      {/* Header */}
      <header className="app-header">
        <div className="app-header-logo">
          <span className="app-header-icon">
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l4 4 10-10"/>
            </svg>
          </span>
          <span className="app-header-title">Accessibility Scanner</span>
        </div>
      </header>

      {/* Main */}
      <main className="welcome-main">
        {/* Hero */}
        <div className="welcome-hero">
          {/* Illustration */}
          <div className="welcome-illustration" aria-hidden="true">
            <span className="welcome-illus-browser">
              <span className="welcome-illus-dots">
                <span/><span/><span/>
              </span>
              <span className="welcome-illus-bar"/>
              <span className="welcome-illus-row">
                <span className="welcome-illus-line" style={{width:'72%'}}/>
                <span className="welcome-illus-err"/>
              </span>
              <span className="welcome-illus-cols">
                <span className="welcome-illus-block"/>
                <span className="welcome-illus-text-col">
                  <span className="welcome-illus-line" style={{width:'90%'}}/>
                  <span className="welcome-illus-line" style={{width:'64%'}}/>
                  <span className="welcome-illus-line" style={{width:'78%'}}/>
                </span>
              </span>
              <span className="welcome-illus-line" style={{width:'46%'}}/>
              <span className="welcome-illus-highlight"/>
            </span>
            <span className="welcome-illus-avatar">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="4.5" r="2"/><path d="M5 8.5l7 1.5 7-1.5M12 10v5M12 15l-3 6M12 15l3 6"/>
              </svg>
            </span>
            <span className="welcome-illus-tick"/>
          </div>

          {/* Label */}
          <div className="welcome-label">
            <span className="section-label-dots">
              <span style={{background:'var(--green)'}}/><span style={{background:'var(--purple)'}}/>
            </span>
            {isConnected ? 'CONNECTED — READY TO SCAN' : 'AUTHORIZATION NEEDED'}
          </div>

          {/* Heading */}
          <h1 className="welcome-title">
            Welcome to <span className="welcome-title-accent">AccessBit Checker</span>
          </h1>

          <p className="welcome-desc">
            {isLoading
              ? 'Checking authorization status…'
              : isConnected
              ? `Click Start Scanning to audit ${siteName} against WCAG 2.1 / 2.2 A & AA rules.`
              : 'The authorization process appears to be incomplete. To continue with the next step, please make sure all the necessary authorization steps have been carried out.'}
          </p>

          <button className="welcome-cta" onClick={handleClick} disabled={isLoading}>
            {isLoading ? 'Loading…' : isAuthenticated ? 'Start Scanning' : 'Authorize'}
            {!isLoading && (
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            )}
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="app-footer"/>
    </div>
  );
};

export default WelcomeScreen;
