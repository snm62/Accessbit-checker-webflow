import { useState, useEffect, useRef } from 'react';
import { jwtDecode } from 'jwt-decode';
import { WORKER_BASE_URL } from '../util/constants';
import { WebflowAPI } from '../types/webflowtypes';

declare const webflow: WebflowAPI;

// Session token is kept only in memory — never persisted
let inMemorySessionToken: string | null = null;
let inMemoryTokenExpiry: number | null = null;

const STORAGE_KEY = 'accessibility-checker-siteinfo';

function readStoredSiteInfo(): { siteId: string; siteName: string; shortName: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.siteId ? parsed : null;
  } catch {
    return null;
  }
}

function storeStoredSiteInfo(info: { siteId: string; siteName: string; shortName: string }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(info)); } catch {}
}

function clearStoredSiteInfo() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function setToken(token: string) {
  inMemorySessionToken = token;
  try {
    const decoded = jwtDecode(token) as { exp?: number };
    inMemoryTokenExpiry = decoded.exp ? decoded.exp * 1000 : Date.now() + 55 * 60 * 1000;
  } catch {
    inMemoryTokenExpiry = Date.now() + 55 * 60 * 1000;
  }
}

function clearToken() {
  inMemorySessionToken = null;
  inMemoryTokenExpiry = null;
}

function isTokenValid(): boolean {
  if (!inMemorySessionToken || !inMemoryTokenExpiry) return false;
  return Date.now() < inMemoryTokenExpiry - 60_000;
}

export interface SiteInfo {
  siteId: string;
  siteName: string;
  shortName: string;
  stagingUrl?: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  siteInfo: SiteInfo | null;
  authorize: () => void;
  makeAuthRequest: (path: string, init?: RequestInit) => Promise<Response>;
  logout: () => void;
}

async function tryDesignerAuth(siteId: string): Promise<string | null> {
  try {
    const idToken = await webflow.getIdToken();
    const res = await fetch(`${WORKER_BASE_URL}/api/scanner/auth/designer-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, idToken }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { sessionToken?: string };
    return data.sessionToken ?? null;
  } catch {
    return null;
  }
}

export function useAuth(): AuthState {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
  const pollRef = useRef<number | null>(null);

  const attemptAuth = async () => {
    try {
      const info = await webflow.getSiteInfo();
      const stagingDomain = info.domains?.find((d: any) => d.stage === 'staging');
      const productionDomain = info.domains?.find((d: any) => d.stage === 'production' || d.default);
      const stagingUrl = stagingDomain
        ? `https://${stagingDomain.url}`
        : productionDomain
        ? `https://${productionDomain.url}`
        : '';

      const resolved: SiteInfo = {
        siteId: info.siteId,
        siteName: info.siteName,
        shortName: info.shortName,
        stagingUrl,
      };
      setSiteInfo(resolved);

      if (isTokenValid()) {
        setIsAuthenticated(true);
        return true;
      }

      const token = await tryDesignerAuth(info.siteId);
      if (token) {
        setToken(token);
        storeStoredSiteInfo({ siteId: info.siteId, siteName: info.siteName, shortName: info.shortName });
        setIsAuthenticated(true);
        return true;
      }
    } catch {
     
    }
    return false;
  };

  useEffect(() => {
    (async () => {
      setIsLoading(true);

    
      const stored = readStoredSiteInfo();
      if (stored) {
        let currentSiteId: string | null = null;
        try { currentSiteId = (await webflow.getSiteInfo()).siteId; } catch {}
        if (currentSiteId && currentSiteId !== stored.siteId) {
          clearStoredSiteInfo();
        } else {
          setSiteInfo({ siteId: stored.siteId, siteName: stored.siteName, shortName: stored.shortName, stagingUrl: '' });
          setIsAuthenticated(true);
          setIsLoading(false);
          // Background: get a real session token and fill in stagingUrl
          attemptAuth();
          return;
        }
      }

      // No stored siteInfo — try silent auth (user may be in Designer after OAuth)
      await attemptAuth();
      setIsLoading(false);
    })();
  }, []);

  const authorize = () => {
    // S3: state is now minted server-side; we pass siteId so it can be embedded in the state
    const siteId = siteInfo?.siteId;

    // Mint a one-time nonce to bind this exact popup to this handler
    const nonce = crypto.randomUUID();
    const authUrl = `${WORKER_BASE_URL}/api/scanner/auth/authorize?nonce=${nonce}${siteId ? `&siteId=${siteId}` : ''}`;

    const authWin = window.open(authUrl, 'wf-scanner-auth', 'width=600,height=700,left=200,top=100');

    if (!authWin) return;

    let authCompleted = false;
    const workerOrigin = new URL(WORKER_BASE_URL).origin;

    // Listen for postMessage from popup (AccessBit pattern)
    const handleMessage = async (event: MessageEvent) => {
      // Validate origin: must come from our worker
      if (!event.origin || event.origin !== workerOrigin) return;
      // Validate source: must come from the exact popup window we opened
      if (event.source !== authWin) return;
      // S4: popup now posts AUTH_COMPLETE only — no token through postMessage
      if (!event.data || event.data.type !== 'AUTH_COMPLETE') return;

      authCompleted = true;
      window.removeEventListener('message', handleMessage, true);
      window.clearInterval(pollRef.current!);
      pollRef.current = null;

      
      await attemptAuth();
    };

    window.addEventListener('message', handleMessage, true);

 
    let pollCount = 0;
    pollRef.current = window.setInterval(async () => {
      pollCount++;
      const closed = authWin.closed;
      const shouldCheck = closed || pollCount % 6 === 0; // every 3 s (6 × 500 ms)
      if (!shouldCheck) return;

      if (closed) {
        window.clearInterval(pollRef.current!);
        pollRef.current = null;
        window.removeEventListener('message', handleMessage, true);
      }

      if (!authCompleted) {
        const success = await attemptAuth();
        if (success) {
          authCompleted = true;
          if (!closed) {
            window.clearInterval(pollRef.current!);
            pollRef.current = null;
            window.removeEventListener('message', handleMessage, true);
          }
        }
      }
    }, 500);
  };

  const makeAuthRequest = async (path: string, init?: RequestInit): Promise<Response> => {
    if (!isTokenValid()) {
      // Lazy token refresh — try webflow.getIdToken() → designer-token
      const stored = readStoredSiteInfo();
      const id = siteInfo?.siteId ?? stored?.siteId;
      if (id) {
        const token = await tryDesignerAuth(id);
        if (token) {
          setToken(token);
          setIsAuthenticated(true);
        } else {
          clearToken();
          clearStoredSiteInfo();
          setIsAuthenticated(false);
          throw new Error('Session expired — please re-authorize');
        }
      } else {
        throw new Error('Not authenticated');
      }
    }

    const url = `${WORKER_BASE_URL}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${inMemorySessionToken}`,
      },
    });
  };

  const logout = () => {
    clearToken();
    clearStoredSiteInfo();
    setIsAuthenticated(false);
    setSiteInfo(null);
  };

  return { isAuthenticated, isLoading, siteInfo, authorize, makeAuthRequest, logout };
}
