'use strict';

function insertMenu($, markup) {
  const navbar = $('#navbarSupportedContent > .navbar-nav');
  if (!navbar.length || !markup) return false;
  navbar.find('.i18n-language-menu').remove();
  const controls = navbar.children('#search-btn,#color-toggle-btn').first();
  if (controls.length) controls.before(markup);
  else navbar.append(markup);
  return true;
}

module.exports = { insertMenu };
