// getInitialData() removed — seed data populated via Firebase per-station paths only.

// CATEGORIES.icon is an icon NAME used with icons.js (js/icons.js icon()).
// `label` is only a fallback: the UI renders category names through
// ui.js `catLabel()` -> i18n keys (modal.item.cat.*). Keep these English so
// an English session can never fall back to Arabic.
export const CATEGORIES = {
  medication:    { label:'Medication Bag',      icon:'pill',       color:'#C8102E' },
  lifepak:       { label:'Lifepak',             icon:'zap',        color:'#7B8794' },
  responder:     { label:'Responder',           icon:'bag',        color:'#E53935' },
  suction:       { label:'Suction',              icon:'wind',       color:'#536477' },
  carevent:      { label:'CAREVENT',             icon:'pulse',      color:'#3B82F6' },
  station_store: { label:'Station Store',        icon:'store',      color:'#F1F5F9' },
  car_contents:  { label:'Car Contents',         icon:'ambulance',  color:'#D97706' },
};
