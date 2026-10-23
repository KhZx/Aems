import { initI18n, getCurrentLang, setLanguage } from './i18n.js';

initI18n();

const languageButton = document.getElementById('languageButton');
languageButton?.addEventListener('click', () => {
  setLanguage(getCurrentLang() === 'en' ? 'ar' : 'en');
});

document.getElementById('refreshButton')?.addEventListener('click', () => {
  window.location.reload();
});

const panel = document.getElementById('visualPanel');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (panel && !reduceMotion && !window.matchMedia('(pointer: coarse)').matches) {
  panel.addEventListener('pointermove', (event) => {
    const rect = panel.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    panel.style.setProperty('--tilt-x', `${(x * 2.4).toFixed(2)}deg`);
    panel.style.setProperty('--tilt-y', `${(y * -2.4).toFixed(2)}deg`);
  });
  panel.addEventListener('pointerleave', () => {
    panel.style.setProperty('--tilt-x', '0deg');
    panel.style.setProperty('--tilt-y', '0deg');
  });
}
