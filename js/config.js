// ═══════════════════════════════════════════════════════════════
//  AEMS — Configuration
//  NEVER commit real keys to a public repository.
// ═══════════════════════════════════════════════════════════════

// ── Firebase ──────────────────────────────────────────────────
// Firebase Console → Project Settings → Your Apps → Web App
export const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC-1klNXQJBuPUNOYFk8lJXR3eOpyqUrWA",
  authDomain:        "aems-a100.firebaseapp.com",
  databaseURL:       "https://aems-a100-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "aems-a100",
  storageBucket:     "aems-a100.firebasestorage.app",
  messagingSenderId: "60102789978",
  appId:             "1:60102789978:web:30aef9bb1e9e0911958163",
  measurementId:     "G-VVEMJ0X900",
};

// ── Backend API ───────────────────────────────────────────
// Railway URL for the REST API. Set this to your service domain
// before deploying to Vercel, e.g. "https://aems-api.up.railway.app"
// (leave empty on purpose for local dev — localhost:4000 is used then).
export const RAILWAY_API_ORIGIN = "https://aems-production-fef1.up.railway.app";

// ── App Settings ──────────────────────────────────────────────
export const APP_VERSION   = "1.0.0";
export const DEFAULT_ROLE  = "paramedic"; // "paramedic" | "supervisor" | "control"
export const WARN_DAYS     = 30;          // days before expiry to show warning
export const MAX_HISTORY   = 200;         // max audit log entries kept locally
