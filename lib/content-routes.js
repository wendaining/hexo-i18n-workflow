'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const yaml = require('js-yaml');
const Hexo = require('hexo');
const { Permalink, slugize } = require('hexo-util');
const { mergeConfig } = require('./config');

const peerRequire = createRequire(require.resolve('hexo/package.json'));
const postPermalink = peerRequire('./dist/plugins/filter/post_permalink');
const { toDate, timezone } = peerRequire('./dist/plugins/processor/common');
const dateParameters = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'i_month', 'i_day', 'hash']);

function filenameMetadata(config, relative) {
  const rule = config.new_post_name.slice(0, -path.extname(config.new_post_name).length);
  const name = relative.slice(0, -path.extname(relative).length);
  const parser = new Permalink(rule, { segments: {
    year: /(\d{4})/, month: /(\d{2})/, day: /(\d{2})/, i_month: /(\d{1,2})/, i_day: /(\d{1,2})/, hash: /([0-9a-f]{12})/
  } });
  const parsed = parser.parse(name);
  return parsed ? { ...parsed, title: parsed.title === undefined ? slugize(name) : parsed.title } : { title: slugize(name) };
}

function postRoute(repo, hexo, version, relative) {
  const info = filenameMetadata(hexo.config, relative.slice('_posts/'.length));
  const data = { ...version.data, source: relative, slug: info.title };
  const preserved = new Set(['title', 'year', 'month', 'day', 'i_month', 'i_day', 'hash']);
  for (const [key, value] of Object.entries(info)) if (!preserved.has(key)) data[key] = value;
  if (!Object.hasOwn(data, 'title') && hexo.config.use_slug_as_post_title) data.title = info.title;
  if (data.permalink) data.__permalink = data.permalink;
  let date = toDate(data.date);
  if (!date && info.year && (info.month || info.i_month) && (info.day || info.i_day)) {
    date = new Date(Number(info.year), Number(info.month || info.i_month) - 1, Number(info.day || info.i_day));
  }
  if (date && hexo.config.timezone) date = timezone(date, hexo.config.timezone);
  if (!date) {
    const rule = new Permalink(hexo.config.permalink);
    if (!data.__permalink && rule.params.some(parameter => dateParameters.has(parameter))) {
      if (repo.rev) throw new Error(`${version.file}: date-dependent revision routes require a front matter date or dated filename`);
      date = fs.statSync(path.resolve(repo.baseDir, version.file)).birthtime;
    } else {
      date = hexo.model('Post').schema.path('date').options.default();
    }
  }
  data.date = hexo.model('Post').schema.path('date').cast(date);
  if (!data.__permalink && new Permalink(hexo.config.permalink).params.includes('id') && !data.id && !data._id) {
    throw new Error(`${version.file}: ID-based routes require an explicit content ID or a generated route manifest`);
  }
  const categories = [].concat(data.categories || data.category || []).filter(value => value != null && value !== '');
  const hierarchy = categories.some(Array.isArray) ? categories[categories.length - 1] : categories;
  const names = [].concat(hierarchy || []).filter(value => value != null && value !== '').map(String);
  const categorySlug = names.map(name => slugize((hexo.config.category_map || {})[name] || name, { transform: hexo.config.filename_case })).join('/');
  data.categories = new (hexo.model('Category').Query)(categorySlug ? [{ slug: categorySlug }] : []);
  return hexo.route.format(postPermalink.call(hexo, data));
}

function pageRoute(hexo, version, relative) {
  let route = version.data.permalink || relative.slice(0, -path.extname(relative).length) + '.html';
  if (route.endsWith('/')) route += 'index';
  if (!path.posix.extname(route)) route += '.html';
  return hexo.route.format(route);
}

function createContentRoutes(repo, config, content, { manifests = [] } = {}) {
  const byUrl = new Map();
  const byFile = new Map();
  const actual = new Map(manifests.flatMap(manifest => Object.entries(manifest.contents || {}).map(([id, version]) => [version.file, { ...version, id, siteLanguage: manifest.language }])));
  const contexts = new Map();
  const context = code => {
    if (contexts.has(code)) return contexts.get(code);
    const language = config.languages.find(value => value.code === code);
    const override = language.configFile ? yaml.load(repo.read(language.configFile)) : {};
    const hexo = new Hexo(config.baseDir, { safe: true });
    hexo.config = mergeConfig(mergeConfig(mergeConfig(hexo.config, config.hexoConfig), override), {
      language: code, root: language.path, url: language.url, source_dir: language.sourceDir
    });
    contexts.set(code, hexo);
    return hexo;
  };
  for (const entry of content) {
    for (const version of Object.values(entry.versions)) {
      const language = config.languages.find(value => value.code === version.siteLanguage);
      let resolved = actual.get(version.file);
      if (!resolved) {
        const hexo = context(version.siteLanguage);
        const relative = path.posix.relative(language.source, version.file);
        const route = entry.kind === 'post' ? postRoute(repo, hexo, version, relative)
          : entry.kind === 'data' ? hexo.route.format(entry.route) : pageRoute(hexo, version, relative);
        resolved = { id: entry.id, file: version.file, language: version.language, siteLanguage: version.siteLanguage,
          route, url: new URL(route.replace(/(^|\/)index\.html$/, '$1'), language.url).href };
      }
      byFile.set(version.file, resolved);
      for (const value of [resolved.url, new URL(resolved.route, language.url).href]) {
        const url = new URL(value); url.search = ''; url.hash = '';
        const previous = byUrl.get(url.href);
        if (previous && previous.id !== entry.id) throw new Error(`Duplicate content route: ${url.href}`);
        byUrl.set(url.href, resolved);
      }
    }
  }
  return { byUrl, byFile, versions: [...byFile.values()] };
}

module.exports = { createContentRoutes };
