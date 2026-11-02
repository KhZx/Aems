import { icon } from './icons.js';
import { onLanguageChanged, t } from './i18n.js';

const STORAGE_KEY = 'aems_sidebar_collapsed';
const DESKTOP_QUERY = '(min-width: 901px)';

function navText(button) {
  const copy = button.cloneNode(true);
  copy.querySelectorAll('.nav-icon, .nav-badge, [data-nav-decoration]').forEach((el) => el.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

function prepareItems(sidebar) {
  const items = [...sidebar.querySelectorAll('.nav-item')];
  items.forEach((button, index) => {
    for (const node of [...button.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (!text.trim()) continue;
        const label = document.createElement('span');
        label.className = 'nav-label-text';
        label.textContent = text.trim();
        node.replaceWith(label);
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SPAN'
        && !node.classList.contains('nav-icon') && !node.classList.contains('nav-badge')) {
        if (node.id?.endsWith('-nav-badge')) node.classList.add('nav-badge');
        else node.classList.add('nav-label-text');
      }
    }
    button.style.animationDelay = `${Math.min(index, 12) * 18}ms`;
    button.title = navText(button);
    button.setAttribute('aria-label', button.title);
  });
  return items;
}

export function initSidebarNavigation() {
  const sidebar = document.querySelector('aside.sidebar, aside#sidebar, #sidebar.sidebar');
  if (!sidebar || sidebar.dataset.navEnhanced === 'true') return;
  sidebar.dataset.navEnhanced = 'true';
  if (!sidebar.id) sidebar.id = 'sidebar';

  const items = prepareItems(sidebar);
  const header = sidebar.querySelector('.sidebar-header, .sidebar-logo');
  if (!header) return;

  // Normalize the three role-specific brand headers into one compactible row.
  const brand = document.createElement('div');
  brand.className = 'sidebar-brand-content';
  while (header.firstChild) brand.appendChild(header.firstChild);
  const mark = document.createElement('span');
  mark.className = 'sidebar-mini-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = 'A';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sidebar-collapse-toggle';
  toggle.innerHTML = icon('arrowLeft');
  toggle.setAttribute('aria-controls', sidebar.id || 'sidebar');
  header.classList.add('sidebar-brand-row');
  header.append(brand, mark, toggle);

  const desktop = window.matchMedia(DESKTOP_QUERY);
  let savedCollapsed = false;
  try { savedCollapsed = localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* optional preference */ }

  function updateLabels() {
    for (const button of items) {
      const label = navText(button);
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    const label = t(collapsed ? 'common.nav.expand' : 'common.nav.collapse');
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.innerHTML = icon('arrowLeft');
  }

  function applySavedState() {
    document.body.classList.toggle('sidebar-collapsed', desktop.matches && savedCollapsed);
    updateLabels();
  }

  toggle.addEventListener('click', () => {
    const next = !document.body.classList.contains('sidebar-collapsed');
    savedCollapsed = next;
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* in-memory toggle still works */ }
    document.body.classList.toggle('sidebar-collapsed', desktop.matches && next);
    updateLabels();
  });

  const onResize = () => applySavedState();
  desktop.addEventListener?.('change', onResize);
  if (!desktop.addEventListener) desktop.addListener(onResize);
  onLanguageChanged(updateLabels);
  applySavedState();
}
