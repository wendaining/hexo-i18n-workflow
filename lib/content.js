'use strict';

const path = require('node:path');
const { parseFrontMatter } = require('./markdown');
const { selectLanguages } = require('./config');

function contentLanguage(data, defaultLanguage, location) {
  if (data.lang != null && data.language != null && data.lang !== data.language) throw new Error(`${location}: lang and language conflict`);
  const language = data.lang == null ? data.language == null ? defaultLanguage : data.language : data.lang;
  if (typeof language !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(language)) throw new Error(`${location}: invalid content language`);
  return language;
}

function contentId(data, relative, location) {
  if (data.translation_key == null) return relative;
  if (typeof data.translation_key !== 'string' || !data.translation_key.trim()) throw new Error(`${location}: translation_key must be a nonempty string`);
  return data.translation_key;
}

function isPublic(data) {
  return data.published !== false && (data.password == null || data.password === '') && !data.encrypt;
}

function legacyRoute(relative, kind) {
  if (kind === 'data') return `data/${relative.slice('_data/'.length).replace(/\.[^.]+$/, '')}/`;
  if (kind === 'post') return `posts/${relative.slice('_posts/'.length).replace(/\.[^.]+$/, '')}/`;
  return relative.replace(/(?:^|\/)index\.[^.]+$/, '/').replace(/\.[^.]+$/, '').replace(/^\//, '').replace(/\/?$/, '/');
}

function contentFiles(repo, language) {
  return repo.list(language.source).filter(file => /\.(?:md|markdown)$/i.test(file)).flatMap(file => {
    const relative = path.posix.relative(language.source, file);
    if (relative.startsWith('_drafts/') || (relative.startsWith('_') && !relative.startsWith('_posts/'))) return [];
    const parsed = parseFrontMatter(repo.read(file));
    if (!isPublic(parsed.data)) return [];
    return [{ file, relative, kind: relative.startsWith('_posts/') ? 'post' : 'page', data: parsed.data }];
  });
}

function enumerateContent(repo, config) {
  const sourceSite = config.languages.find(language => language.code === config.defaultLanguage);
  const content = new Map();
  const sourceFiles = contentFiles(repo, sourceSite);
  const dataDefinitions = new Map();
  for (const extension of config.extensions) {
    if (extension.content == null) continue;
    if (!Array.isArray(extension.content)) throw new Error(`${extension.modulePath}: content extension must be an array`);
    for (const definition of extension.content) {
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('Data content definition must be an object');
      if (typeof definition.relative !== 'string' || !definition.relative || path.posix.isAbsolute(definition.relative) || definition.relative.split('/').includes('..')) throw new Error('Data content relative path is invalid');
      const id = definition.id || definition.relative;
      if (dataDefinitions.has(id)) throw new Error(`Duplicate content extension identity: ${id}`);
      if (definition.validate != null && typeof definition.validate !== 'function') throw new Error(`${id}: validate must be a function`);
      dataDefinitions.set(id, definition);
      const file = path.posix.join(sourceSite.source, definition.relative);
      if (!repo.exists(file)) throw new Error(`Missing data content source: ${file}`);
      sourceFiles.push({ file, relative: definition.relative, kind: definition.kind || 'data', data: { translation_key: id }, definition });
    }
  }
  for (const source of sourceFiles) {
    const id = contentId(source.data, source.relative, source.file);
    if (content.has(id)) throw new Error(`Duplicate content identity: ${id}`);
    const sourceLanguage = contentLanguage(source.data, config.defaultLanguage, source.file);
    const entry = {
      id, kind: source.kind, source: source.file, sourceLanguage, relative: source.relative,
      explicitKey: source.data.translation_key != null,
      route: source.definition && source.definition.route || legacyRoute(source.relative, source.kind),
      data: source.data,
      definition: source.definition || null,
      versions: { [sourceLanguage]: { file: source.file, language: sourceLanguage, siteLanguage: config.defaultLanguage, source: true, data: source.data } }
    };
    content.set(id, entry);
  }
  for (const language of selectLanguages(config)) {
    const translatedFiles = contentFiles(repo, language);
    for (const definition of dataDefinitions.values()) {
      const file = path.posix.join(language.source, definition.relative);
      if (repo.exists(file)) translatedFiles.push({ file, relative: definition.relative, kind: definition.kind || 'data', data: { translation_key: definition.id || definition.relative } });
    }
    const seen = new Set();
    for (const translated of translatedFiles) {
      const id = contentId(translated.data, translated.relative, translated.file);
      if (seen.has(id)) throw new Error(`Duplicate content identity in ${language.code}: ${id}`);
      seen.add(id);
      const entry = content.get(id);
      if (!entry) throw new Error(`${translated.file}: orphan translation`);
      const actualLanguage = contentLanguage(translated.data, language.code, translated.file);
      if (actualLanguage !== language.code) throw new Error(`${translated.file}: translation language conflicts with ${language.code}`);
      if (entry.kind !== translated.kind) throw new Error(`${translated.file}: content kinds differ`);
      if (entry.versions[actualLanguage]) throw new Error(`${id}: duplicate language version ${actualLanguage}`);
      entry.versions[actualLanguage] = { file: translated.file, language: actualLanguage, siteLanguage: language.code, source: false, data: translated.data };
    }
  }
  return [...content.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function findContentByFile(content, file, baseDir = null) {
  const normalized = path.isAbsolute(file) && baseDir ? path.relative(baseDir, file).split(path.sep).join('/') : String(file).split(path.sep).join('/');
  return content.find(entry => Object.values(entry.versions).some(version => version.file === normalized)) || null;
}

function listRequiredPairs(repo, config, { lang } = {}) {
  const languages = selectLanguages(config, lang);
  return enumerateContent(repo, config).flatMap(entry => languages.flatMap(language => {
    const version = entry.versions[language.code];
    if (version && version.source) return [];
    if (!version && language.mode === 'partial') return [];
    return [{ id: entry.id, route: entry.route, kind: entry.kind, source: entry.source, translation: version ? version.file : path.posix.join(language.source, entry.relative), sourceLanguage: entry.sourceLanguage, language: language.code, entry }];
  }));
}

function resolvePair(repo, config, input, { lang } = {}) {
  const languages = selectLanguages(config, lang);
  const pairs = enumerateContent(repo, config).flatMap(entry => languages.map(language => {
    const version = entry.versions[language.code];
    return { id: entry.id, route: entry.route, kind: entry.kind, source: entry.source, translation: version ? version.file : path.posix.join(language.source, entry.relative), sourceLanguage: entry.sourceLanguage, language: language.code, entry };
  }));
  const raw = String(input);
  const exact = pairs.find(pair => pair.id === raw);
  if (exact) return exact;
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return pairs.find(pair => pair.id === normalized || pair.source === normalized || pair.translation === normalized || pair.route.replace(/\/$/, '') === normalized || (pair.kind === 'post' && path.posix.basename(pair.source).replace(/\.[^.]+$/, '') === normalized)) || null;
}

module.exports = { enumerateContent, contentLanguage, contentId, isPublic, findContentByFile, listRequiredPairs, resolvePair, legacyRoute };
