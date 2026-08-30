import { initializeApp, getApps, getApp }       from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  reauthenticateWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, set, get, push, remove, onValue, update, serverTimestamp, onDisconnect
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

let _app, _db, _auth;

export function initFirebase(config) {
  _app  = getApps().length ? getApp() : initializeApp(config);
  _auth = getAuth(_app);
  if (config.databaseURL) {
    try { _db = getDatabase(_app); } catch { _db = null; }
  }
  return { app: _app, db: _db, auth: _auth };
}

export function getFirebaseApp()  { return _app; }
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

// ── Connection state ─────────────────────────────────────────
export function watchConnection(callback) {
  if (!_db) { callback(false); return () => {}; }
  return onValue(ref(_db, '.info/connected'), snap => callback(snap.val() === true));
}

// ── User profile ─────────────────────────────────────────────
export async function writeUserProfile(uid, data) {
  if (!_db || !uid) return;
  await set(ref(_db, `users/${uid}`), data);
}

export function watchUserProfile(uid, callback) {
  if (!_db || !uid) { callback(null); return () => {}; }
  return onValue(ref(_db, `users/${uid}`), snap => callback(snap.val()));
}

export async function getUserProfile(uid) {
  if (!_db || !uid) return null;
  const snap = await get(ref(_db, `users/${uid}`));
  return snap.val();
}

export async function updateUserProfile(uid, patch) {
  if (!_db || !uid) return;
  await update(ref(_db, `users/${uid}`), patch);
}

// ── Station presence ─────────────────────────────────────────
export function setOnlinePresence(stationId, paramedicInfo) {
  if (!_db || !stationId) return;
  const presenceRef = ref(_db, `stations/${stationId}/presence`);
  const data = { online: true, lastSeen: Date.now(), paramedic: paramedicInfo };
  set(presenceRef, data);
  onDisconnect(presenceRef).update({ online: false, lastSeen: serverTimestamp() });
}

export function watchStationPresence(stationId, callback, onError) {
  if (!_db) { callback(null); return () => {}; }
  return onValue(ref(_db, `stations/${stationId}/presence`), snap => {
    callback(snap.val());
  }, onError || (err => console.warn(`watchStationPresence(${stationId}): ${err.code}`)));
}

// ── Equipment items (keyed object storage) ────────────────────
// Stored as: stations/{stationId}/items/{itemId} = { ...item }
// This enables single-item updates instead of full-array replacement.

function _asKeyed(items) {
  const obj = {};
  (items || []).forEach(item => {
    const id = item.id != null ? String(item.id) : String(Date.now() + Math.random());
    obj[id] = { ...item, id };
  });
  return obj;
}

// Bulk save (converts array to keyed object, replaces entire items node)
export async function saveItems(stationId, items) {
  await set(ref(_db, `stations/${stationId}/items`), _asKeyed(items));
}

// Save/update a single item at stations/{stationId}/items/{itemId}
export async function saveItem(stationId, item) {
  const id = item.id != null ? String(item.id) : String(Date.now());
  await set(ref(_db, `stations/${stationId}/items/${id}`), { ...item, id, updatedAt: serverTimestamp() });
  return id;
}

// Remove a single item
export async function removeItem(stationId, itemId) {
  await remove(ref(_db, `stations/${stationId}/items/${itemId}`));
}

// Update a single field on an item (e.g. quantity after use)
export async function updateItemField(stationId, itemId, field, value) {
  await update(ref(_db, `stations/${stationId}/items/${itemId}`), {
    [field]: value,
    updatedAt: serverTimestamp(),
  });
}

// Watch returns array (converted from keyed object internally)
export function watchItems(stationId, callback, onError) {
  return onValue(
    ref(_db, `stations/${stationId}/items`),
    snap => {
      const val = snap.val();
      if (!val) { callback([]); return; }
      callback(Object.values(val));
    },
    onError || (err => console.warn(`watchItems(${stationId}): ${err.code}`))
  );
}

export async function getItemsOnce(stationId) {
  const snap = await get(ref(_db, `stations/${stationId}/items`));
  const val = snap.val();
  if (!val) return [];
  return Object.values(val);
}

// ── Shift notes (also keyed) ──────────────────────────────────
export async function saveShiftNotes(stationId, notes) {
  await set(ref(_db, `stations/${stationId}/shiftNotes`), _asKeyed(notes));
}

export function watchShiftNotes(stationId, callback) {
  return onValue(ref(_db, `stations/${stationId}/shiftNotes`), snap => {
    const val = snap.val();
    if (!val) { callback([]); return; }
    callback(Object.values(val));
  });
}

// ── Station users index ───────────────────────────────────────
// station_users/{stationCode}/{uid}: { name, empId, role }
// Eliminates need to read entire /users node to find station staff.
export async function writeStationUser(code, uid, profile) {
  if (!_db) return;
  await set(ref(_db, `station_users/${code}/${uid}`), {
    name: profile.name || '',
    empId: profile.empId || '',
    role: profile.role || 'paramedic',
  });
}

export async function removeStationUser(code, uid) {
  if (!_db) return;
  await remove(ref(_db, `station_users/${code}/${uid}`));
}

// Watch station staff — reads the index only (small payload, 2-5 users)
export function watchStationUsers(code, callback, onError) {
  if (!_db) { callback([]); return () => {}; }
  return onValue(ref(_db, `station_users/${code}`), snap => {
    const val = snap.val();
    if (!val) { callback([]); return; }
    const entries = Object.entries(val);
    const users = entries.map(([uid, data]) => ({
      uid,
      name: (data && typeof data === 'object' ? (data.name || '') : '') || '',
      empId: (data && typeof data === 'object' ? (data.empId || '') : '') || '',
      role: (data && typeof data === 'object' ? (data.role || 'paramedic') : '') || 'paramedic',
      status: 'active',
    }));
    callback(users);
  }, onError || (err => console.warn(`watchStationUsers(${code}): ${err.code}`)));
}

// ── Single shift note operations ───────────────────────────────
export async function saveShiftNote(stationId, note) {
  const id = note.id != null ? String(note.id) : String(Date.now());
  await set(ref(_db, `stations/${stationId}/shiftNotes/${id}`), { ...note, id, updatedAt: serverTimestamp() });
  return id;
}

export async function removeShiftNote(stationId, noteId) {
  await remove(ref(_db, `stations/${stationId}/shiftNotes/${noteId}`));
}

// ── Station info / settings (per-user, stored under user profile) ─
export async function saveStationInfo(userId, info) {
  if (!_db || !userId) return;
  await set(ref(_db, `users/${userId}/stationInfo`), info);
}

export function watchStationInfo(userId, callback) {
  if (!_db || !userId) { callback(null); return () => {}; }
  return onValue(ref(_db, `users/${userId}/stationInfo`), snap => callback(snap.val()));
}

// ── Inspection snapshot (Firebase-backed) ─────────────────────

// ── Reports ───────────────────────────────────────────────────
export async function pushReport(report) {
  const r = ref(_db, 'reports');
  await push(r, { ...report, sentAt: serverTimestamp() });
}

export function watchReports(callback) {
  return onValue(ref(_db, 'reports'), snap => {
    if (!snap.val()) return callback([]);
    const list = Object.entries(snap.val())
      .map(([id, r]) => ({ ...r, _fbId: id }))
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    callback(list);
  });
}

// ── Audit Log (single source of truth) ────────────────────────
export async function pushAuditLog(entry) {
  if (!_db) return;
  await push(ref(_db, 'audit'), { ...entry, sentAt: serverTimestamp() });
}

export function watchAuditLog(callback) {
  if (!_db) { callback([]); return () => {}; }
  return onValue(ref(_db, 'audit'), snap => {
    if (!snap.val()) return callback([]);
    const list = Object.entries(snap.val())
      .map(([id, e]) => ({ ...e, _fbId: id }))
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    callback(list.slice(0, 200));
  });
}

// ── Users Directory (index for admin listing) ────────────────
export async function writeUserDirectory(uid, data) {
  if (!_db) return;
  await set(ref(_db, `users_directory/${uid}`), {
    name: data.name || '',
    email: data.email || '',
    role: data.role || 'paramedic',
    empId: data.empId || '',
    station: data.station || '',
    stationName: data.stationName || data.station || '',
    status: data.status || 'pending',
    createdAt: data.createdAt || Date.now(),
    supervisorZone: data.supervisorZone || null,
    badgeNumber: data.badgeNumber || null,
    managedStations: data.managedStations || [],
  });
}

export async function updateUserDirectory(uid, patch) {
  if (!_db) return;
  await update(ref(_db, `users_directory/${uid}`), patch);
}

export async function removeUserDirectory(uid) {
  if (!_db) return;
  await remove(ref(_db, `users_directory/${uid}`));
}

export async function deleteUserProfile(uid) {
  if (!_db) return;
  await remove(ref(_db, `users/${uid}`));
}

export function watchUsersDirectory(callback) {
  if (!_db) { callback([]); return () => {}; }
  return onValue(ref(_db, 'users_directory'), snap => {
    const val = snap.val() || {};
    const list = Object.entries(val).map(([uid, data]) => ({ uid, ...data }));
    callback(list.sort((a, b) => a.name?.localeCompare(b.name) || 0));
  });
}

export const isConfigured = (config) => !config.apiKey.includes('YOUR');

// ── Stations Directory ────────────────────────────────────────
export async function createStation(code, name) {
  if (!_db) throw new Error('Database not connected');
  await set(ref(_db, `stations_directory/${code}`), { name, createdAt: Date.now() });
}

export async function getStationByCode(code) {
  if (!_db) return null;
  const snap = await get(ref(_db, `stations_directory/${code}`));
  return snap.val();
}

export function watchStationsDirectory(callback) {
  if (!_db) { callback([]); return () => {}; }
  return onValue(ref(_db, 'stations_directory'), snap => {
    const val = snap.val() || {};
    const list = Object.entries(val).map(([code, data]) => ({ code, ...data }));
    callback(list.sort((a, b) => a.code.localeCompare(b.code)));
  });
}

export async function deleteStation(code) {
  if (!_db) return;
  await remove(ref(_db, `stations_directory/${code}`));
}

// ── Shift Handovers ───────────────────────────────────────────
export async function saveHandover(stationId, handover) {
  if (!_db) return null;
  const r = push(ref(_db, `stations/${stationId}/handovers`));
  await set(r, { ...handover, createdAt: serverTimestamp() });
  return r.key;
}

export async function acknowledgeHandover(stationId, handoverId, incomingData) {
  if (!_db) return;
  await update(ref(_db, `stations/${stationId}/handovers/${handoverId}`), {
    ...incomingData,
    status: 'complete',
    acknowledgedAt: serverTimestamp(),
  });
}

export function watchHandovers(stationId, callback) {
  if (!_db) { callback([]); return () => {}; }
  return onValue(ref(_db, `stations/${stationId}/handovers`), snap => {
    if (!snap.val()) return callback([]);
    const list = Object.entries(snap.val())
      .map(([id, h]) => ({ ...h, _id: id }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    callback(list.slice(0, 50));
  });
}

// ── Clear Operational Data (preserves users + stations_directory) ──
// Clears all station sub-data (items, shiftNotes, handovers, presence)
// plus reports and audit logs. Does NOT touch users, station_users,
// or stations_directory.
export async function clearStationOperationalData(stationId) {
  if (!_db) return;
  await Promise.allSettled([
    remove(ref(_db, `stations/${stationId}/items`)).catch(() => {}),
    remove(ref(_db, `stations/${stationId}/shiftNotes`)).catch(() => {}),
    remove(ref(_db, `stations/${stationId}/handovers`)).catch(() => {}),
    remove(ref(_db, `stations/${stationId}/presence`)).catch(() => {}),
  ]);
}

export async function clearReports() {
  if (!_db) return;
  await remove(ref(_db, 'reports')).catch(() => {});
}

export async function clearAudit() {
  if (!_db) return;
  await remove(ref(_db, 'audit')).catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────
export function stationKey(name) {
  return (name || '').trim()
    .replace(/[.$#[\]/\\]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'default';
}
