// js/auth.js — session handling: Firebase sign-in → backend session.

import { FIREBASE_CONFIG } from './config.js';
import { initFirebase } from './services/firebase.js';
import { api, setToken } from './api.js';

const SESSION_KEY = 'aems_session';

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  setToken(session?.token || null);
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  setToken(null);
}

export function hasPermission(perm) {
  const s = getSession();
  return Array.isArray(s?.permissions) && s.permissions.includes(perm);
}

export function roleRedirectPath(session) {
  const role = session?.user?.role;
  if (role === 'ADMIN') return '/admin.html';
  if (role === 'SUPERVISOR') return '/supervisor.html';
  return '/app.html';
}

/** Waits for Firebase to restore the signed-in user (or resolve null). */
export function waitForAuthUser(timeout = 8000) {
  const { auth } = initFirebase(FIREBASE_CONFIG);
  if (!auth) return Promise.resolve(null);
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    const unsub = auth.onAuthStateChanged((u) => {
      unsub();
      resolve(u);
    });
    setTimeout(() => {
      unsub();
      resolve(auth.currentUser);
    }, timeout);
  });
}

export async function getFirebaseIdToken() {
  const user = await waitForAuthUser();
  if (!user) return null;
  try {
    return await user.getIdToken(true);
  } catch {
    return null;
  }
}

/** Calls POST /auth/login and stores the returned session. */
export async function loginWithBackend() {
  const token = await getFirebaseIdToken();
  if (!token) return null;
  setToken(token);
  const payload = await api.login(token);
  const session = { token, ...payload };
  setSession(session);
  return session;
}

/** Re-authenticates after a 401. Returns true on success. */
export async function renewSession() {
  try {
    const session = await loginWithBackend();
    return !!session;
  } catch {
    clearSession();
    return false;
  }
}

/** Entry point for protected pages: returns a valid session or null. */
export async function initAppSession() {
  const cached = getSession();
  if (cached) setToken(cached.token);
  const fbUser = await waitForAuthUser();
  if (!fbUser) {
    clearSession();
    return null;
  }
  if (cached && cached.user?.firebaseUid === fbUser.uid) {
    return cached; // re-validated lazily on first 401
  }
  return loginWithBackend();
}

export async function registerWithBackend(payload) {
  const token = await getFirebaseIdToken();
  if (!token) throw new Error('Not signed in');
  return api.register(payload, token);
}

export async function signOutAll() {
  const { firebaseSignOut } = await import('./services/firebase.js');
  clearSession();
  try {
    await firebaseSignOut();
  } catch { /* ignore */ }
  window.location.href = '/login.html';
}
