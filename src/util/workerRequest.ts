import { WORKER_BASE_URL } from './constants';

const WORKER_ORIGIN = new URL(WORKER_BASE_URL).origin;

export function workerUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error('workerUrl: path must start with /');
  return `${WORKER_BASE_URL.replace(/\/+$/, '')}${path}`;
}

export function assertTrustedWorkerUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (parsed.origin !== WORKER_ORIGIN) throw new Error('Untrusted URL');
}

export function fetchWorker(url: string, init?: RequestInit): Promise<Response> {
  assertTrustedWorkerUrl(url);
  return fetch(url, init);
}
