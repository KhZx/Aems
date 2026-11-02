import { api, openNotificationStream } from './api.js';
import { icon } from './icons.js';
import { onLanguageChanged, t } from './i18n.js';

let initialized = false;
let isLoading = false;
let refreshAgain = false;
let streamController = null;
let fallbackPoll = null;
let active = true;
let unreadTotal = 0;
let notifications = [];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function notificationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setBadge() {
  const badge = document.getElementById('notificationBadge');
  const button = document.getElementById('notificationBell');
  if (!badge || !button) return;
  badge.textContent = unreadTotal > 99 ? '99+' : String(unreadTotal);
  badge.hidden = unreadTotal <= 0;
  const panelUnread = document.getElementById('notificationPanelUnread');
  if (panelUnread) panelUnread.textContent = unreadTotal ? t('notifications.unread_count', { count: unreadTotal }) : '';
  button.classList.toggle('has-critical', notifications.some((n) => !n.readAt && !n.resolvedAt && n.severity === 'CRITICAL'));
  button.setAttribute('aria-label', `${t('notifications.title')}${unreadTotal ? ` (${unreadTotal})` : ''}`);
}

function renderPanel() {
  const list = document.getElementById('notificationList');
  const markAll = document.getElementById('notificationMarkAll');
  if (!list) return;
  if (!notifications.length) {
    list.innerHTML = `<div class="notification-empty">${t('notifications.empty')}</div>`;
  } else {
    list.innerHTML = notifications.map((n) => {
      const data = n.data && typeof n.data === 'object' ? n.data : {};
      const title = t(n.titleKey, data);
      const body = t(n.bodyKey, data);
      const severity = ['CRITICAL', 'ACTION', 'INFO'].includes(n.severity) ? n.severity.toLowerCase() : 'info';
      return `<button type="button" class="notification-entry ${n.readAt ? 'read' : 'unread'} ${n.resolvedAt ? 'resolved' : ''} ${severity}" data-notification-id="${esc(n.id)}">
        <span class="notification-entry-icon">${icon(severity === 'critical' ? 'alert' : severity === 'action' ? 'activity' : 'bell')}</span>
        <span class="notification-entry-copy">
          <span class="notification-entry-top"><strong>${esc(title)}</strong>${!n.readAt ? '<i aria-label="Unread"></i>' : ''}</span>
          <span class="notification-entry-body">${esc(body)}</span>
          <span class="notification-entry-meta">${esc(notificationTime(n.createdAt))}${n.resolvedAt ? ` · ${esc(t('notifications.resolved'))}` : ''}</span>
        </span>
      </button>`;
    }).join('');
    list.querySelectorAll('[data-notification-id]').forEach((button) => {
      button.addEventListener('click', () => void openNotification(button.dataset.notificationId));
    });
  }
  if (markAll) markAll.disabled = unreadTotal === 0;
  setBadge();
}

async function refreshNotifications() {
  if (isLoading) { refreshAgain = true; return; }
  isLoading = true;
  try {
    do {
      refreshAgain = false;
      const result = await api.notifications({ page: 1, pageSize: 30 });
      notifications = result?.notifications || [];
      unreadTotal = Number(result?.unread) || 0;
      renderPanel();
    } while (refreshAgain);
  } catch (error) {
    const list = document.getElementById('notificationList');
    if (list && !notifications.length) list.innerHTML = `<div class="notification-empty">${t('notifications.unavailable')}</div>`;
    // The bell is intentionally quiet on connectivity failures; it retries via SSE/poll fallback.
    console.debug('Notification refresh failed:', error?.message || error);
  } finally {
    isLoading = false;
  }
}

async function openNotification(id) {
  const item = notifications.find((n) => n.id === id);
  if (!item) return;
  try {
    await api.markNotificationRead(id);
    await refreshNotifications();
  } catch { /* keep the notification visible if marking read fails */ }
  closePanel();

  const data = item.data && typeof item.data === 'object' ? item.data : {};
  const destination = data.page;
  if (destination === 'inspections') {
    if (typeof window.showPage === 'function') window.showPage('inspections');
    if (data.inspectionId && typeof window.openInspectionDetails === 'function') {
      setTimeout(() => window.openInspectionDetails(data.inspectionId), 80);
    }
  } else if (destination === 'supply') {
    if (typeof window.showPage === 'function') window.showPage('supply');
    else if (window.App?.navigateTo) window.App.navigateTo('supply');
    else if (typeof window.navTo === 'function') window.navTo('logs');
  } else if (destination === 'equipment' && window.App?.navigateTo) {
    window.App.navigateTo('equipment', data.category || 'medication');
  } else if (destination === 'equipment' && typeof window.showPage === 'function') {
    window.showPage('stations');
  } else if (destination === 'equipment' && typeof window.navTo === 'function') {
    window.navTo('equipment');
  } else if (destination === 'stations' && typeof window.navTo === 'function') {
    window.navTo('stations');
  } else if (typeof window.showPage === 'function' && destination) {
    window.showPage(destination);
  }
}

function closePanel() {
  const root = document.getElementById('notificationCenter');
  const button = document.getElementById('notificationBell');
  root?.classList.remove('open');
  button?.setAttribute('aria-expanded', 'false');
}

function setPanelOpen(open) {
  const root = document.getElementById('notificationCenter');
  const button = document.getElementById('notificationBell');
  if (!root || !button) return;
  root.classList.toggle('open', open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) void refreshNotifications();
}

function startFallbackPolling() {
  if (fallbackPoll || !active) return;
  fallbackPoll = setInterval(() => void refreshNotifications(), 60_000);
}
function stopFallbackPolling() {
  if (fallbackPoll) clearInterval(fallbackPoll);
  fallbackPoll = null;
}

function parseSseBlock(block) {
  let eventName = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (eventName === 'ready' || eventName === 'refresh' || eventName === 'message') void refreshNotifications();
}

async function consumeStream(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (active && !signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let splitAt;
      while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        if (block && !block.startsWith(':')) parseSseBlock(block);
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
}

async function runStream(signal) {
  let delay = 1_000;
  while (active && !signal.aborted) {
    try {
      const body = await openNotificationStream(signal);
      delay = 1_000;
      stopFallbackPolling();
      await consumeStream(body, signal);
      if (active && !signal.aborted) throw new Error('Notification stream ended');
    } catch (error) {
      if (!active || signal.aborted) break;
      startFallbackPolling();
      console.debug('Notification stream reconnecting:', error?.message || error);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

export function initNotificationCenter() {
  if (initialized) return;
  const headerActions = document.querySelector('#topbar .topbar-right')
    || document.querySelector('.topbar-right')
    || document.querySelector('header.topbar > div:last-child');
  if (!headerActions) return;
  initialized = true;

  const root = document.createElement('div');
  root.id = 'notificationCenter';
  root.className = 'notification-center';
  root.innerHTML = `<button type="button" id="notificationBell" class="notification-bell" aria-haspopup="dialog" aria-expanded="false">
      ${icon('bell')}<span id="notificationBadge" class="notification-badge" hidden>0</span>
    </button>
    <section class="notification-panel" role="dialog" aria-label="${esc(t('notifications.title'))}">
      <header class="notification-panel-head"><div><strong data-notification-title>${esc(t('notifications.title'))}</strong><span id="notificationPanelUnread"></span></div>
        <button type="button" id="notificationMarkAll" class="notification-mark-all">${esc(t('notifications.mark_all_read'))}</button></header>
      <div id="notificationList" class="notification-list"><div class="notification-empty">${esc(t('notifications.loading'))}</div></div>
    </section>`;
  headerActions.prepend(root);

  document.getElementById('notificationBell').addEventListener('click', () => {
    setPanelOpen(!root.classList.contains('open'));
  });
  document.getElementById('notificationMarkAll').addEventListener('click', async () => {
    if (!unreadTotal) return;
    try { await api.markAllNotificationsRead(); await refreshNotifications(); } catch { /* refresh will retry */ }
  });
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) closePanel();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePanel(); });
  onLanguageChanged(() => {
    const title = root.querySelector('[data-notification-title]');
    if (title) title.textContent = t('notifications.title');
    document.getElementById('notificationMarkAll').textContent = t('notifications.mark_all_read');
    void refreshNotifications();
  });

  void refreshNotifications();
  streamController = new AbortController();
  void runStream(streamController.signal);
  window.addEventListener('beforeunload', () => {
    active = false;
    streamController?.abort();
    stopFallbackPolling();
  }, { once: true });
}
