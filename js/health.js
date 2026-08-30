// js/health.js — live server + database status dots.
import { getApiBase } from './api.js';
const POLL_MS = 15000;

function setChip(kind, state) {
  const root = document.querySelector(`[data-health="${kind}"]`);
  if (!root) return;
  root.classList.remove('ok', 'down', 'checking');
  root.classList.add(state);
  const dot = root.querySelector('.health-dot');
  if (dot) dot.title = state === 'ok' ? 'Live' : state === 'down' ? 'Offline' : 'Checking...';
}

async function ping() {
  const API_BASE = getApiBase();
  setChip('server', 'checking');
  setChip('db', 'checking');
  if (!API_BASE) { setChip('server', 'down'); setChip('db', 'down'); return; }
  try {
    const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
    let db = 'down';
    try {
      const json = await res.json();
      if (json?.data?.database === 'ok') db = 'ok';
    } catch { /* non-JSON body */ }
    setChip('server', res.ok ? 'ok' : 'down');
    setChip('db', db);
  } catch {
    setChip('server', 'down');
    setChip('db', 'down');
  }
}

/** Polls /health and updates every [data-health] chip. Returns a stop fn. */
export function startHealthMonitor(intervalMs = POLL_MS) {
  const timer = setInterval(ping, intervalMs);
  ping();
  return () => clearInterval(timer);
}