import { initializeApp, getApps, getApp }       from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  reauthenticateWithCredential, EmailAuthProvider, updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ─────────────────────────────────────────────────────────────────
//  FIREBASE = AUTHENTICATION ONLY.
//
//  All application data (inventory, stations, users, shift notes,
//  handovers, reports, audit) lives in PostgreSQL behind the API in
//  /server. The Realtime Database client SDK used to be imported here
//  with read/write/clear helpers. That was a security problem: those
//  helpers wrote straight to the database with nothing but the public
//  API key, bypassing every scope/permission/audit check the API
//  enforces — and the deployed rules were not version-controlled.
//
//  The database surface has therefore been removed. Do not re-add
//  direct database reads or writes to the frontend: go through api.js.
// ─────────────────────────────────────────────────────────────────

let _app, _auth;

export function initFirebase(config) {
  _app  = getApps().length ? getApp() : initializeApp(config);
  _auth = getAuth(_app);
  return { app: _app, auth: _auth };
}

export function getFirebaseAuth() { return _auth; }

// ── Auth ─────────────────────────────────────────────────────
export function watchAuth(callback) {
  return onAuthStateChanged(_auth, callback);
}

export async function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(_auth, email, password);
}

export async function signUpWithEmail(email, password) {
  return createUserWithEmailAndPassword(_auth, email, password);
}

export async function firebaseSignOut() {
  if (_auth) await signOut(_auth);
}

// Re-authenticate the currently signed-in user with their password
export async function reauthenticateAdmin(password) {
  if (!_auth || !_auth.currentUser) throw new Error('Not authenticated');
  const email = _auth.currentUser.email;
  if (!email) throw new Error('No email on current user');
  const credential = EmailAuthProvider.credential(email, password);
  await reauthenticateWithCredential(_auth.currentUser, credential);
}

/**
 * Change the signed-in user's own password. Re-authenticates with the current
 * password first (Firebase requires a recent login) and then updates it. The
 * current session is kept — the user does not have to sign in again.
 */
export async function changeOwnPassword(currentPassword, newPassword) {
  if (!_auth || !_auth.currentUser) {
    const err = new Error('Not authenticated');
    err.code = 'auth/not-signed-in';
    throw err;
  }
  const email = _auth.currentUser.email;
  if (!email) {
    const err = new Error('No email on current user');
    err.code = 'auth/not-signed-in';
    throw err;
  }
  const credential = EmailAuthProvider.credential(email, currentPassword);
  await reauthenticateWithCredential(_auth.currentUser, credential);
  await updatePassword(_auth.currentUser, newPassword);
}

export const isConfigured = (config) => !config.apiKey.includes('YOUR');

/**
 * Normalises a station code into a database-safe key fragment.
 * Purely a string helper — it performs no database access.
 */
export function stationKey(name) {
  return (name || '').trim()
    .replace(/[.$#[\]/\\]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'default';
}