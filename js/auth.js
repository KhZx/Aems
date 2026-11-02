// js/auth.js — session handling: Firebase sign-in → backend session.

import { FIREBASE_CONFIG } from './config.js';
import { initFirebase } from './services/firebase.js';
import { api, setToken } from './api.js';

const SESSION_KEY = 'aems_session';

/**
 * The cached session holds the profile and permissions only. The ID token is
 * never written to localStorage (any script on the page could read it); it is
 * kept in memory and re-obtained from Firebase on every page load.
 */
export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session && 'token' in session) {
      // Scrub a token persisted by an earlier build.
      const { token: _legacy, ...clean } = session;
      localStorage.setItem(SESSION_KEY, JSON.stringify(clean));
      return clean;
    }
    return session;
  } catch {
    return null;
  }
}

export function setSession(session) {
  const { token, ...profile } = session || {};
  localStorage.setItem(SESSION_KEY, JSON.stringify(profile));
  // Only replace the in-memory token when one is supplied; profile-only updates
  // (e.g. a background refresh) must not drop the live token.
  if (token !== undefined) setToken(token || null);
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

/**
 * Returns the Firebase ID token. Firebase reuses a valid cached token, so
 * forcing a refresh (an extra network call) is only needed after a 401.
 */
export async function getFirebaseIdToken(force = false) {
  const user = await waitForAuthUser();
  if (!user) return null;
  try {
    return await user.getIdToken(force);
  } catch {
    return null;
  }
}

/** Calls POST /auth/login and stores the returned session. */
export async function loginWithBackend(force = false) {
  const token = await getFirebaseIdToken(force);
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
    const session = await loginWithBackend(true);
    return !!session;
  } catch {
    clearSession();
    return false;
  }
}

/** Entry point for protected pages: returns a valid session or null. */
export async function initAppSession() {
  const cached = getSession();
  const fbUser = await waitForAuthUser();
  if (!fbUser) {
    clearSession();
    return null;
  }
  const token = await getFirebaseIdToken();
  if (!token) {
    clearSession();
    return null;
  }
  setToken(token);
  // A valid cached session renders straight away. The profile, permissions and
  // roster are refreshed in the background (no audit write), so admin changes
  // such as a widened duty roster show up on the next load without a re-login.
  if (cached && cached.user?.firebaseUid === fbUser.uid && 'dutyRoster' in cached) {
    api.me()
      .then((payload) => setSession({ ...cached, ...payload }))
      .catch(() => { /* re-validated lazily on first 401 */ });
    return cached;
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
