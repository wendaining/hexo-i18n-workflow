'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');
const { load } = require('cheerio');
const { readConfig } = require('./config');
const { Repository } = require('./repository');
const pages = require('./pages');

const ASSET_PATH = 'hexo-i18n-workflow';

function activeLanguage(hexo, config) {
  const selected = process.env.HEXO_I18N_LANGUAGE || (hexo.i18nManifest && hexo.i18nManifest.language)
    || (hexo.config && hexo.config.multilingual && hexo.config.multilingual.current_language);
  if (selected) return selected;
  const source = hexo.source_dir || (hexo.config && hexo.config.source_dir);
  if (!source) return config.defaultLanguage;
  const sourceDir = path.resolve(hexo.base_dir || config.baseDir, source);
  const actualSourceDir = fs.existsSync(sourceDir) ? fs.realpathSync(sourceDir) : sourceDir;
  const language = config.languages.find(item => {
    const configured = path.resolve(item.sourceDir);
    return (fs.existsSync(configured) ? fs.realpathSync(configured) : configured) === actualSourceDir;
  });
  if (!language) throw new Error(`Source directory is not configured for multilingual builds: ${sourceDir}`);
  return language.code;
}

function runtimeContent(hexo, config, language, page) {
  const { enumerateContent, findContentByFile } = require('./content');
  if (!hexo.i18nContents) hexo.i18nContents = enumerateContent(new Repository({ baseDir: hexo.base_dir }), config);
  const contents = hexo.i18nContents;
  const sourceDir = config.languages.find(item => item.code === language).sourceDir;
  const found = {};
  const collect = post => {
    if (!post || !post.path || (!post.source && !post.full_source)) return;
    const file = post.full_source || path.resolve(sourceDir, post.source);
    const content = findContentByFile(contents, file, config.baseDir);
    if (!content) return;
    const version = Object.values(content.versions).find(item => item.siteLanguage === language);
    if (!version) return;
    found[content.id] = {
      route: post.path,
      url: new URL(pages.canonicalRoute(post.path), config.languages.find(item => item.code === language).url).href,
      file: version.file,
      language: version.language,
      kind: content.kind
    };
  };
  const posts = hexo.locals.get('all_posts') || hexo.locals.get('posts');
  for (const locals of [posts, hexo.locals.get('pages')]) {
    if (locals) locals.forEach(collect);
  }
  for (const content of contents.filter(item => item.kind === 'data')) {
    const version = Object.values(content.versions).find(item => item.siteLanguage === language);
    if (!version || !content.route) continue;
    found[content.id] = {
      route: hexo.route.format(content.route),
      url: new URL(pages.canonicalRoute(content.route), config.languages.find(item => item.code === language).url).href,
      file: version.file,
      language: version.language,
      kind: content.kind
    };
  }
  collect(page);
  return found;
}

function getRuntimeIndex(hexo, page = null) {
  const config = hexo.i18nConfig || readConfig({ baseDir: hexo.base_dir });
  const language = activeLanguage(hexo, config);
  const languageConfig = config.languages.find(item => item.code === language);
  if (!languageConfig) throw new Error(`Unknown current language: ${language}`);
  const previous = process.env.HEXO_I18N_MANIFESTS
    ? JSON.parse(fs.readFileSync(process.env.HEXO_I18N_MANIFESTS, 'utf8'))
    : [];
  const current = hexo.i18nManifest || {
    language,
    root: languageConfig.path,
    output: hexo.public_dir,
    contents: runtimeContent(hexo, config, language, page),
    routes: hexo.route.list()
  };
  if (page) {
    current.contents = { ...runtimeContent(hexo, config, language, page), ...current.contents };
  }
  current.routes = hexo.route.list();
  return pages.createPageIndex(config, [...previous.filter(manifest => manifest.language !== language), current]);
}

function queryFor(hexo, page, index) {
  const query = { language: activeLanguage(hexo, index.config), route: page.canonical_path || page.path || '' };
  if (page.contentId) query.contentId = page.contentId;
  return query;
}

function commentOptions(config) {
  const custom = (config.extensions || []).find(extension => typeof extension.discussionId === 'function');
  return custom ? { discussionId: custom.discussionId } : {};
}

function install(hexo) {
  if (hexo.i18nPageInstalled) return;
  hexo.i18nPageInstalled = true;
  for (const name of ['error', 'e', 'fatal']) {
    const original = hexo.log[name];
    hexo.log[name] = function(...args) {
      const message = format(...args);
      process.exitCode = 1;
      original.apply(this, args);
      throw new Error(`Hexo logged ${name === 'fatal' ? 'FATAL' : 'ERROR'}: ${message}`);
    };
  }
  const { checkRepository } = require('./records');
  const { validateContentRoutes, validateGenerators } = require('./runner');
  hexo.extend.filter.register('before_generate', function() {
    const config = hexo.i18nConfig || readConfig({ baseDir: hexo.base_dir });
    const repo = new Repository({ baseDir: hexo.base_dir });
    const current = process.env.HEXO_I18N_LANGUAGE;
    const lang = current ? current === config.defaultLanguage ? [] : [current] : undefined;
    const result = checkRepository(repo, config, { lang });
    if (result.errors.length) throw new Error(result.errors.join('\n'));
    validateContentRoutes(hexo);
    validateGenerators(hexo);
  }, 1000);
  hexo.extend.helper.register('i18n_versions', function(page = this.page) {
    const index = getRuntimeIndex(hexo, page);
    return pages.languageVersions(index, queryFor(hexo, page, index));
  });
  hexo.extend.helper.register('i18n_language_menu', function(page = this.page) {
    const index = getRuntimeIndex(hexo, page);
    return pages.renderLanguageMenu(pages.languageVersions(index, queryFor(hexo, page, index)));
  });
  hexo.extend.helper.register('i18n_comments', function(page = this.page) {
    const index = getRuntimeIndex(hexo, page);
    return pages.commentIdentity(index, queryFor(hexo, page, index), commentOptions(index.config));
  });
  hexo.extend.helper.register('i18n_notice', function(page = this.page, format = 'html') {
    const index = getRuntimeIndex(hexo, page);
    return pages.renderTranslationNotice(pages.translationNotice(index, queryFor(hexo, page, index)), { format });
  });
  hexo.extend.helper.register('i18n_sitemap_url', function() {
    const config = hexo.i18nConfig || readConfig({ baseDir: hexo.base_dir });
    return new URL('sitemap.xml', config.siteUrl).href;
  });
  hexo.extend.generator.register('i18n-workflow-assets', function() {
    return ['js', 'css'].map(type => ({
      path: `${type}/${ASSET_PATH}/language-menu.${type}`,
      data: fs.readFileSync(path.join(__dirname, '..', 'assets', `language-menu.${type}`))
    }));
  });
  hexo.extend.filter.register('after_post_render', function(page) {
    if (!page || page.layout !== 'post' || typeof page.content !== 'string') return page;
    const index = getRuntimeIndex(hexo, page);
    const notice = pages.translationNotice(index, queryFor(hexo, page, index));
    if (notice && !load(page.content, null, false)('.translation-notice').length) {
      page.content = pages.renderTranslationNotice(notice) + page.content;
    }
    return page;
  }, 40);
  hexo.extend.filter.register('after_render:html', function(html, data) {
    const $ = load(html);
    if (!$('html').length || !$('head').length) return html;
    const page = data && data.page;
    if (!page) return html;
    const index = getRuntimeIndex(hexo, page);
    const query = queryFor(hexo, page, index);
    const versions = pages.languageVersions(index, query);
    const current = pages.currentVersion(index, query);
    if (current) $('html').attr('lang', current.language);
    require('../adapters/fluid').insertMenu($, pages.renderLanguageMenu(versions));
    if (!$('script[data-i18n-workflow]').length) {
      const language = index.config.languages.find(item => item.code === query.language);
      $('head').append($('<script defer data-i18n-workflow></script>').attr('src', `${language.path}js/${ASSET_PATH}/language-menu.js`));
      $('head').append($('<link rel="stylesheet" data-i18n-workflow>').attr('href', `${language.path}css/${ASSET_PATH}/language-menu.css`));
    }
    return $.html();
  }, 100);
}

module.exports = { activeLanguage, getRuntimeIndex, install, queryFor };
