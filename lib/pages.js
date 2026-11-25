'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');

function canonicalRoute(route) {
  return String(route || '').replace(/^\/+/, '').replace(/(^|\/)index\.html$/i, '$1');
}

function siteUrl(config, manifest) {
  const source = config.siteUrl || config.url || (config.siteConfig && config.siteConfig.url);
  if (source) return new URL(manifest.root || '/', source).href;
  const first = Object.values(manifest.contents || {}).find(item => item.url);
  if (!first) throw new Error(`Site URL is missing for ${manifest.language}`);
  return new URL(manifest.root || '/', first.url).href;
}

function generatedUrl(config, manifest, route) {
  return new URL(canonicalRoute(route), siteUrl(config, manifest)).href;
}

function createPageIndex(config, manifests) {
  const index = { config, manifests, contents: new Map(), routes: new Map(), paths: new Map(), generated: new Map() };
  for (const manifest of manifests) {
    const languageConfig = config.languages.find(language => language.code === manifest.language);
    if (!languageConfig) throw new Error(`Unknown manifest language: ${manifest.language}`);
    for (const [id, content] of Object.entries(manifest.contents || {})) {
      const actualLanguage = content.language || manifest.language;
      const actualLanguageConfig = config.languages.find(language => language.code === actualLanguage);
      const version = {
        ...content,
        contentId: id,
        code: actualLanguage,
        language: actualLanguage,
        siteLanguage: manifest.language,
        name: actualLanguageConfig ? actualLanguageConfig.name : actualLanguage,
        route: canonicalRoute(content.route),
        isSource: manifest.language === config.defaultLanguage,
        manifest
      };
      if (!version.url) version.url = generatedUrl(config, manifest, version.route);
      if (!index.contents.has(id)) index.contents.set(id, []);
      index.contents.get(id).push(version);
      index.routes.set(`${manifest.language}:${version.route}`, version);
      index.paths.set(new URL(version.url).pathname, version);
    }
    for (const route of manifest.routes || []) {
      if (!/\.html$/i.test(route) && !String(route).endsWith('/')) continue;
      const canonical = canonicalRoute(route);
      if (index.routes.has(`${manifest.language}:${canonical}`)) continue;
      const version = {
        contentId: `@route/${canonical}`,
        code: manifest.language,
        language: manifest.language,
        siteLanguage: manifest.language,
        name: languageConfig.name,
        route: canonical,
        url: generatedUrl(config, manifest, canonical),
        isSource: manifest.language === config.defaultLanguage,
        generated: true,
        manifest
      };
      if (!index.generated.has(canonical)) index.generated.set(canonical, []);
      index.generated.get(canonical).push(version);
      index.routes.set(`${manifest.language}:${canonical}`, version);
      index.paths.set(new URL(version.url).pathname, version);
    }
  }
  return index;
}

function currentVersion(index, query) {
  if (query.contentId) {
    const versions = index.contents.get(query.contentId) || [];
    return versions.find(version => version.siteLanguage === query.language)
      || versions.find(version => version.isSource && version.language === query.language)
      || null;
  }
  return index.routes.get(`${query.language}:${canonicalRoute(query.route)}`) || null;
}

function languageVersions(index, query) {
  const current = currentVersion(index, query);
  if (!current) return [];
  const versions = current.generated
    ? index.generated.get(current.route)
    : index.contents.get(current.contentId);
  const order = new Map(index.config.languages.map((language, position) => [language.code, position]));
  const unique = new Map();
  for (const version of versions) {
    const existing = unique.get(version.language);
    if (!existing || version.isSource) unique.set(version.language, version);
  }
  return [...unique.values()]
    .sort((left, right) => (order.get(left.language) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.language) ?? Number.MAX_SAFE_INTEGER))
    .map(version => ({ ...version, current: version.url === current.url }));
}

function commentIdentity(index, query, options = {}) {
  const current = currentVersion(index, query);
  if (!current) throw new Error(`Content route is unknown: ${query.contentId || query.route}`);
  const versions = languageVersions(index, query);
  const original = versions.find(version => version.isSource);
  if (!original) throw new Error(`Original content route is missing: ${current.contentId}`);
  const identity = {
    contentId: current.contentId,
    currentLanguage: current.language,
    sourceUrl: original.url,
    currentUrl: current.url,
    discussionId: current.contentId
  };
  const comments = index.config.comments || {};
  const mode = options.mode || comments.mode || 'shared';
  if (mode !== 'shared' && mode !== 'independent') throw new Error(`Unknown comment mode: ${mode}`);
  if (mode === 'independent') identity.discussionId = `${identity.contentId}:${identity.currentLanguage}`;
  const extension = (index.config.extensions || []).find(item => typeof item.discussionId === 'function');
  const customize = options.discussionId || comments.discussionId || (extension && extension.discussionId);
  if (customize) {
    if (typeof customize !== 'function') throw new Error('Custom discussionId must be a function');
    identity.discussionId = customize(identity);
    if (typeof identity.discussionId !== 'string' || !identity.discussionId) {
      throw new Error('Custom discussionId must return a nonempty string');
    }
  }
  return identity;
}

function translationNotice(index, query) {
  const current = currentVersion(index, query);
  if (!current || current.isSource || current.kind === 'data' || current.generated) return null;
  const original = languageVersions(index, query).find(version => version.isSource);
  if (!original || original.language === current.language) return null;
  const language = index.config.languages.find(item => item.code === current.siteLanguage);
  if (!language.notice) return null;
  const notice = typeof language.notice === 'string' ? { text: language.notice } : language.notice;
  if (!notice.text || typeof notice.text !== 'string') throw new Error(`Notice text is missing for ${language.code}`);
  return {
    language: current.language,
    sourceLanguage: original.language,
    sourceUrl: original.url,
    currentUrl: current.url,
    text: notice.text,
    linkText: notice.link_text || notice.linkText || original.name
  };
}

function escapeHtml(value) {
  const $ = load('<span></span>', null, false);
  $('span').text(String(value));
  return $('span').html();
}

function renderTranslationNotice(notice, { format = 'html' } = {}) {
  if (!notice) return '';
  if (format === 'markdown') {
    const label = notice.linkText.replace(/([\\[\]])/g, '\\$1');
    const link = `[${label}](<${notice.sourceUrl}>)`;
    const text = notice.text.includes('{original}') ? notice.text.replaceAll('{original}', link) : `${notice.text} ${link}`;
    return `${text.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
  }
  if (format !== 'html') throw new Error(`Unknown notice format: ${format}`);
  const $ = load('<div class="note note-warning translation-notice"><p></p></div>', null, false);
  const parts = notice.text.includes('{original}') ? notice.text.split('{original}') : [notice.text + ' ', ''];
  $('p').text(parts[0]);
  for (const part of parts.slice(1)) {
    $('p').append($('<a></a>').attr('href', notice.sourceUrl).attr('hreflang', notice.sourceLanguage).text(notice.linkText));
    $('p').append(escapeHtml(part));
  }
  return $.html();
}

function renderLanguageMenu(versions) {
  if (!versions.length) return '';
  const current = versions.find(version => version.current) || versions[0];
  const $ = load('<li class="nav-item dropdown i18n-language-menu"><button type="button" class="nav-link dropdown-toggle language-switch i18n-language-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="i18n-language-options"></button><div id="i18n-language-options" class="dropdown-menu i18n-language-options" hidden></div></li>', null, false);
  $('.i18n-language-toggle').attr('lang', current.language).attr('aria-label', current.name).text(current.name);
  for (const version of versions) {
    const url = new URL(version.url);
    const target = url.origin === new URL(current.url).origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
    const item = $('<a class="dropdown-item language-switch" data-language-switch data-anchor-map="{}"></a>');
    item.attr('href', target).attr('data-target', target)
      .attr('hreflang', version.language).attr('lang', version.language).text(version.name);
    if (version.current) item.attr('aria-current', 'page');
    $('.i18n-language-options').append(item);
  }
  return $.html();
}

function headings($) {
  const selector = '.markdown-body h1[id],.markdown-body h2[id],.markdown-body h3[id],.markdown-body h4[id],.markdown-body h5[id],.markdown-body h6[id],.page-content h1[id],.page-content h2[id],.page-content h3[id],.page-content h4[id],.page-content h5[id],.page-content h6[id],article h1[id],article h2[id],article h3[id],article h4[id],article h5[id],article h6[id]';
  const content = $(selector);
  const elements = content.length ? content : $('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]').filter((_, element) => !$(element).closest('nav,header,footer').length);
  return elements.map((_, element) => ({ id: $(element).attr('id'), level: element.tagName })).get();
}

function headingMap(from, to) {
  if (from.length !== to.length || from.some((heading, position) => heading.level !== to[position].level)) return {};
  return Object.fromEntries(from.map((heading, position) => [heading.id, to[position].id]));
}

function outputFile(outputDir, version) {
  const route = version.route.endsWith('/') || !version.route ? `${version.route}index.html` : version.route;
  return path.join(outputDir, version.manifest.root.replace(/^\/+/, ''), route);
}

function rewriteContentLinks($, index, current, headingData) {
  $('a[href]').not('[data-language-switch],.translation-notice a').each((_, element) => {
    const link = $(element);
    const raw = link.attr('href');
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) return;
    const targetUrl = new URL(raw, current.url);
    if (targetUrl.origin !== new URL(current.url).origin) return;
    let target = index.paths.get(targetUrl.pathname);
    let restoredSource = false;
    if (!target) {
      const original = index.manifests.find(manifest => manifest.language === index.config.defaultLanguage);
      if (original) {
        for (const manifest of [...index.manifests].sort((left, right) => right.root.length - left.root.length)) {
          if (manifest.language === index.config.defaultLanguage || !targetUrl.pathname.startsWith(manifest.root)) continue;
          const sourceUrl = new URL(targetUrl.pathname.slice(manifest.root.length), siteUrl(index.config, original));
          const candidate = index.paths.get(sourceUrl.pathname);
          if (candidate && candidate.isSource) {
            target = candidate;
            restoredSource = true;
            break;
          }
        }
      }
    }
    if (!target) return;
    const targetQuery = target.generated
      ? { route: target.route, language: target.siteLanguage }
      : { contentId: target.contentId, language: target.siteLanguage };
    const counterpart = languageVersions(index, targetQuery)
      .find(version => version.language === current.language) || (restoredSource ? target : null);
    if (!counterpart) return;
    const replacement = new URL(counterpart.url);
    replacement.search = targetUrl.search;
    if (targetUrl.hash) {
      const anchor = decodeURIComponent(targetUrl.hash.slice(1));
      const map = headingMap(headingData.get(target.url) || [], headingData.get(counterpart.url) || []);
      if (map[anchor]) replacement.hash = map[anchor];
      else if ((headingData.get(counterpart.url) || []).some(heading => heading.id === anchor)) replacement.hash = anchor;
    }
    link.attr('href', raw.startsWith('/') ? `${replacement.pathname}${replacement.search}${replacement.hash}` : replacement.href);
  });
}

function enrichPages(config, manifests, outputDir) {
  const index = createPageIndex(config, manifests);
  const documents = new Map();
  const headingData = new Map();
  for (const version of index.routes.values()) {
    const file = outputFile(outputDir, version);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    const $ = load(html);
    documents.set(version.url, { $, file, html, version });
    headingData.set(version.url, headings($));
  }
  const fluid = require('../adapters/fluid');
  for (const { $, file, html, version } of documents.values()) {
    const query = { language: version.siteLanguage, route: version.route };
    const versions = languageVersions(index, query);
    $('html').attr('lang', version.language);
    $('link[rel="canonical"]').remove();
    $('head').append(`<link rel="canonical" href="${escapeHtml(version.url)}">`);
    $('link[rel="alternate"][hreflang]').remove();
    for (const alternate of versions) {
      const link = $('<link rel="alternate">').attr('hreflang', alternate.language).attr('href', alternate.url);
      $('head').append(link);
    }
    const original = versions.find(alternate => alternate.isSource);
    if (original) $('head').append($('<link rel="alternate" hreflang="x-default">').attr('href', original.url));
    const menu = renderLanguageMenu(versions);
    if (!fluid.insertMenu($, menu)) $('.i18n-language-menu').replaceWith(menu);
    const notice = translationNotice(index, query);
    if (notice && version.kind === 'post') {
      const markdown = $('.markdown-body').first();
      const body = markdown.length ? markdown : $('.page-content,article,main').first();
      if (body.length && !body.find('.translation-notice').length) body.prepend(renderTranslationNotice(notice));
    }
    $('[data-language-switch]').each((_, element) => {
      const link = $(element);
      const target = new URL(link.attr('data-target'), version.url).href;
      const counterpart = versions.find(alternate => alternate.url === target);
      if (!counterpart) throw new Error(`Language menu points to an unknown URL: ${link.attr('data-target')}`);
      link.attr('data-anchor-map', JSON.stringify(headingMap(headingData.get(version.url) || [], headingData.get(counterpart.url) || [])));
    });
    rewriteContentLinks($, index, version, headingData);
    const result = $.html();
    if (result !== html) fs.writeFileSync(file, result);
  }
  return index;
}

module.exports = {
  canonicalRoute,
  commentIdentity,
  createPageIndex,
  currentVersion,
  enrichPages,
  generatedUrl,
  headingMap,
  headings,
  languageVersions,
  renderLanguageMenu,
  renderTranslationNotice,
  translationNotice
};
