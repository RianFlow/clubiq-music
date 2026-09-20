"use strict";

// Keep one navigation and one permission-aware player for every screen size.
const mobileTabIcons = {
  voting: '<path d="m8 12 3 3 5-6"/><rect x="4" y="4" width="16" height="16" rx="4"/>',
  playlists: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  player: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
  library: '<path d="M19 14V4L9 6v10M9 6v4l10-2"/><ellipse cx="6" cy="17" rx="3" ry="3"/><ellipse cx="16" cy="15" rx="3" ry="3"/>',
};
document.querySelectorAll('.tabs [data-tab]').forEach(button => {
  const drawing = mobileTabIcons[button.dataset.tab];
  if (!drawing) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'tab-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = drawing; // Static app-owned paths, never API content.
  button.prepend(svg);
});

// Reserve the actual space, including wrapped controls, larger text and notches.
if (typeof ResizeObserver !== 'undefined') {
  const chromeObserver = new ResizeObserver(entries => {
    for (const {target} of entries) {
      const name = target.id === 'miniPlayer' ? '--mini-player-height' : '--topbar-height';
      document.documentElement.style.setProperty(name, `${Math.ceil(target.getBoundingClientRect().height)}px`);
    }
  });
  ['.topbar', '#miniPlayer'].forEach(selector => {
    const element = document.querySelector(selector);
    if (element) chromeObserver.observe(element);
  });
}

// Switching areas after scrolling a long list must not land at the bottom.
document.querySelector('.tabs').addEventListener('click', event => {
  if (!event.target.closest('[data-tab]')) return;
  if (window.matchMedia('(max-width: 720px)').matches) window.scrollTo({top:0, behavior:'instant'});
});
