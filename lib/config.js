'use strict';

const path = require('node:path');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { Repository } = require('./repository');

function mapping(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} must be a mapping`);
  return value;
}

function text(value, location) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${location} must be a nonempty string`);
  return value;
}

function mergeConfig(left, right) {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
      ? mergeConfig(result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? result[key] : {}, value)
      : value;
  }
  return result;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function related(left, right) {
  return contains(left, right) || contains(right, left);
}

function normalizePath(value, location) {
  text(value, location);
  if (!value.startsWith('/') || !value.endsWith('/') || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw new Error(`${location} must start and end with /`);
  }
  const decoded = decodeURIComponent(value);
  if (decoded.split('/').some(part => part === '.' || part === '..') || /\/\//.test(value)) throw new Error(`${location} contains an unsafe path`);
  return value;
}

function realLocation(directory) {
  let ancestor = directory;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function checkManagedDirectories(config) {
  const protectedDirectories = [
    config.baseDir,
    ...config.languages.map(language => language.sourceDir),
    path.resolve(config.baseDir, 'scripts'),
    path.resolve(config.baseDir, 'node_modules'),
    path.resolve(config.baseDir, 'plugins'),
    path.resolve(config.baseDir, '.git'),
    config.themeDir
  ].filter(Boolean).map(realLocation);
  const base = realLocation(config.baseDir);
  const managed = [config.buildDir, config.outputDir].map(realLocation);
  const persistentFiles = [
    config.recordsPath && path.resolve(config.baseDir, config.recordsPath),
    ...(config.configFiles || []),
    ...config.languages.map(language => language.configFile),
    ...(config.extensions || []).map(extension => extension.modulePath)
  ].filter(Boolean).map(realLocation);
  for (const directory of managed) {
    if (contains(directory, base)) throw new Error(`Managed directory contains the site: ${directory}`);
    for (const source of protectedDirectories.slice(1)) {
      if (related(directory, source)) throw new Error(`Managed directory overlaps a source directory: ${directory}`);
    }
    for (const file of persistentFiles) {
      if (contains(directory, file)) throw new Error(`Managed directory contains a persistent file: ${file}`);
    }
  }
  if (related(managed[0], managed[1])) throw new Error('Build and output directories must be separate');
  return config;
}

function readConfig({ baseDir = process.cwd(), rev = null, hexoConfig = null } = {}) {
  const repo = new Repository({ baseDir, rev });
  const load = file => mapping(yaml.load(repo.read(file)) || {}, file);
  let siteConfig = hexoConfig;
  const configFiles = [];
  if (!siteConfig) {
    siteConfig = load('_config.yml');
    configFiles.push(path.resolve(repo.baseDir, '_config.yml'));
    if (repo.exists('_config.i18n.yml')) {
      siteConfig = mergeConfig(siteConfig, load('_config.i18n.yml'));
      configFiles.push(path.resolve(repo.baseDir, '_config.i18n.yml'));
    }
  }
  mapping(siteConfig, 'Hexo configuration');
  const raw = mapping(siteConfig.multilingual, 'multilingual');
  const defaultLanguage = text(raw.default_language, 'multilingual.default_language');
  if (!Array.isArray(raw.languages) || !raw.languages.length) throw new Error('multilingual.languages must be a nonempty array');
  const codes = new Set();
  const sourceDirectories = new Set();
  const paths = new Set();
  const languages = raw.languages.map((value, index) => {
    const location = `multilingual.languages[${index}]`;
    mapping(value, location);
    const code = text(value.code, `${location}.code`);
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(code)) throw new Error(`${location}.code is invalid`);
    if (codes.has(code.toLowerCase())) throw new Error(`Duplicate language code: ${code}`);
    codes.add(code.toLowerCase());
    const sourceDir = path.resolve(repo.baseDir, text(value.source_dir, `${location}.source_dir`));
    if (sourceDirectories.has(sourceDir)) throw new Error(`Duplicate source directory: ${sourceDir}`);
    sourceDirectories.add(sourceDir);
    const publishPath = normalizePath(value.path, `${location}.path`);
    if (paths.has(publishPath)) throw new Error(`Duplicate language path: ${publishPath}`);
    paths.add(publishPath);
    const mode = value.mode || 'full';
    if (!['full', 'partial'].includes(mode)) throw new Error(`${location}.mode must be full or partial`);
    const configFile = value.config ? path.resolve(repo.baseDir, text(value.config, `${location}.config`)) : null;
    if (configFile && !repo.exists(configFile)) throw new Error(`Missing language configuration: ${configFile}`);
    if (configFile) load(configFile);
    const notice = value.notice == null ? null : mapping(value.notice, `${location}.notice`);
    if (notice) {
      text(notice.text, `${location}.notice.text`);
      text(notice.link_text, `${location}.notice.link_text`);
    }
    return { code, name: text(value.name, `${location}.name`), sourceDir, source: repo.relative(sourceDir), path: publishPath, url: new URL(publishPath, siteConfig.url).href, configFile, mode, notice };
  });
  if (!codes.has(defaultLanguage.toLowerCase()) || !languages.some(language => language.code === defaultLanguage)) throw new Error('default_language must match a configured language code');
  for (let index = 0; index < languages.length; index++) {
    for (let other = index + 1; other < languages.length; other++) {
      if (related(languages[index].sourceDir, languages[other].sourceDir)) throw new Error('Language source directories must be separate');
    }
  }
  if (raw.confirmation != null && typeof raw.confirmation !== 'boolean') throw new Error('multilingual.confirmation must be a boolean');
  const comments = raw.comments == null ? { mode: 'shared' } : mapping(raw.comments, 'multilingual.comments');
  if (!['shared', 'independent'].includes(comments.mode || 'shared')) throw new Error('multilingual.comments.mode must be shared or independent');
  const extensionPaths = raw.extensions || [];
  if (!Array.isArray(extensionPaths)) throw new Error('multilingual.extensions must be an array');
  const extensions = extensionPaths.map((file, index) => {
    const modulePath = path.resolve(repo.baseDir, text(file, `multilingual.extensions[${index}]`));
    if (!repo.exists(modulePath)) throw new Error(`Missing multilingual extension: ${modulePath}`);
    const extension = mapping(repo.loadModule(modulePath), modulePath);
    return { ...extension, modulePath };
  });
  const sharedAssets = raw.shared_assets || [];
  if (!Array.isArray(sharedAssets) || sharedAssets.some(item => typeof item !== 'string' || !item || path.posix.isAbsolute(item) || item.split('/').includes('..') || item.includes('\\'))) {
    throw new Error('multilingual.shared_assets must contain source-relative paths');
  }
  const theme = siteConfig.theme;
  const config = {
    baseDir: repo.baseDir,
    defaultLanguage,
    languages,
    recordsPath: repo.relative(text(raw.records || 'i18n/confirmations.yml', 'multilingual.records')),
    buildDir: path.resolve(repo.baseDir, raw.build_dir || '.hexo-i18n'),
    outputDir: path.resolve(repo.baseDir, raw.output_dir || siteConfig.public_dir || 'public'),
    themeDir: theme ? path.resolve(repo.baseDir, 'themes', theme) : null,
    confirmation: raw.confirmation !== false,
    sharedAssets,
    extensions,
    comments: { ...comments, mode: comments.mode || 'shared' },
    configFiles,
    siteConfig,
    hexoConfig: siteConfig,
    siteUrl: languages.find(language => language.code === defaultLanguage).url,
    url: text(siteConfig.url, 'url'),
    raw
  };
  return checkManagedDirectories(config);
}

function selectLanguages(config, lang, { targets = true } = {}) {
  const candidates = config.languages.filter(language => !targets || language.code !== config.defaultLanguage);
  if (lang == null || lang === 'all' || (Array.isArray(lang) && lang.length === 1 && lang[0] === 'all')) return candidates;
  const codes = (Array.isArray(lang) ? lang : [String(lang)]).flatMap(value => String(value).split(','));
  if (codes.includes('all')) throw new Error('The all selector cannot be combined with individual languages');
  if (new Set(codes).size !== codes.length) throw new Error('Duplicate language selectors');
  return codes.map(code => {
    const language = candidates.find(value => value.code === code);
    if (!language) throw new Error(`Unknown target language: ${code}`);
    return language;
  });
}

function loadExtensions(config) { return config.extensions; }

module.exports = { readConfig, mergeConfig, selectLanguages, checkManagedDirectories, contains, loadExtensions };
