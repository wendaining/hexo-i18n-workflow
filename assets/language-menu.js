(function() {
  'use strict';

  function switchTarget(value, baseUrl, anchor, mapping) {
    const base = new URL(baseUrl);
    const target = new URL(value, base);
    if (anchor && mapping[anchor]) target.hash = mapping[anchor];
    return target.origin === base.origin ? target.pathname + target.search + target.hash : target.href;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { switchTarget };
    return;
  }

  function setOpen(menu, open, focus) {
    const toggle = menu.querySelector('.i18n-language-toggle');
    const options = menu.querySelector('.i18n-language-options');
    toggle.setAttribute('aria-expanded', String(open));
    options.hidden = !open;
    options.classList.toggle('show', open);
    if (open && focus) options.querySelector('a').focus();
  }

  document.addEventListener('click', function(event) {
    const toggle = event.target.closest('.i18n-language-toggle');
    if (toggle) {
      const menu = toggle.closest('.i18n-language-menu');
      setOpen(menu, toggle.getAttribute('aria-expanded') !== 'true', false);
      return;
    }
    document.querySelectorAll('.i18n-language-menu').forEach(function(menu) {
      if (!menu.contains(event.target)) setOpen(menu, false, false);
    });
    const link = event.target.closest('a[data-language-switch]');
    if (!link) return;
    const anchor = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : '';
    const mapping = JSON.parse(link.getAttribute('data-anchor-map'));
    link.href = switchTarget(link.getAttribute('data-target'), window.location.href, anchor, mapping);
  });

  document.addEventListener('keydown', function(event) {
    const menu = event.target.closest('.i18n-language-menu');
    if (!menu) return;
    const toggle = menu.querySelector('.i18n-language-toggle');
    const options = menu.querySelector('.i18n-language-options');
    const links = Array.from(options.querySelectorAll('a'));
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(menu, false, false);
      toggle.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.hidden) {
        setOpen(menu, true, true);
        if (event.key === 'ArrowUp') links[links.length - 1].focus();
      } else {
        const current = links.indexOf(event.target);
        const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
        links[next].focus();
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      if (options.hidden) return;
      event.preventDefault();
      links[event.key === 'Home' ? 0 : links.length - 1].focus();
    } else if (event.key === 'Tab') {
      setTimeout(function() {
        if (!menu.contains(document.activeElement)) setOpen(menu, false, false);
      }, 0);
    }
  });
})();
