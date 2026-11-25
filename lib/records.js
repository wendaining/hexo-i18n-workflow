'use strict';

const path = require('node:path');
const yaml = require('js-yaml');
const { selectLanguages } = require('./config');
const { enumerateContent, contentLanguage, listRequiredPairs } = require('./content');
const { parseFrontMatter, documentSections, hashText, normalizeNewlines, structureSignature, mathKey } = require('./markdown');

function normalizeDateValue(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}.000Z` : text;
}

function metadataFields(data) {
  const fields = ['title', 'excerpt', 'subtitle', 'description', 'date', 'updated', 'tags', 'categories', 'published', 'comments', 'hide', 'encrypt', 'password', 'math', 'mermaid', 'layout', 'comment'];
  return Object.fromEntries(fields.filter(field => data[field] !== undefined).map(field => [field, ['date', 'updated'].includes(field) ? normalizeDateValue(data[field]) : data[field]]));
}
function metadataHash(data) { return hashText(JSON.stringify(metadataFields(data))); }
function isMapping(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function loadRecords(repo, config) {
  if (!repo.exists(config.recordsPath)) return { version: 2, contents: {} };
  const records = yaml.load(repo.read(config.recordsPath));
  if (!isMapping(records)) throw new Error(`${config.recordsPath} must contain a mapping`);
  if (records.version !== 2) throw new Error(`${config.recordsPath}: run the explicit migrate command before checking or confirming`);
  if (!isMapping(records.contents)) throw new Error(`${config.recordsPath}: contents must be a mapping`);
  for (const [id, record] of Object.entries(records.contents)) {
    if (!isMapping(record) || !isMapping(record.translations) || typeof record.source !== 'string' || typeof record.source_language !== 'string') throw new Error(`${id}: invalid confirmation record`);
    for (const [code, baseline] of Object.entries(record.translations)) {
      if (!isMapping(baseline) || typeof baseline.translation !== 'string' || !Array.isArray(baseline.source_sections) || !Array.isArray(baseline.translation_sections)) throw new Error(`${id} (${code}): invalid translation baseline`);
      for (const field of ['source_hash', 'translation_hash', 'source_blob', 'translation_blob', 'source_meta_hash', 'translation_meta_hash']) {
        if (typeof baseline[field] !== 'string' || !baseline[field]) throw new Error(`${id} (${code}): missing ${field}`);
      }
    }
  }
  return records;
}

function writeRecords(repo, config, records) {
  const contents = Object.fromEntries(Object.entries(records.contents).sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => [id, {
    kind: value.kind, source: value.source, source_language: value.source_language,
    translations: Object.fromEntries(Object.entries(value.translations).sort(([left], [right]) => left.localeCompare(right)))
  }]));
  repo.write(config.recordsPath, `# Confirmed multilingual content baselines.\n${yaml.dump({ version: 2, contents }, { lineWidth: -1, noRefs: true, sortKeys: false, quotingType: '"' })}`);
}

function sectionBaselines(text) {
  return documentSections(text).sections.map(section => ({ key: section.key, level: section.level, hash: section.hash }));
}

function sectionsForRecord(sourceText, translationText) {
  return { source_sections: sectionBaselines(sourceText), translation_sections: sectionBaselines(translationText) };
}

function comparableDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = yaml.load(String(value));
  return parsed instanceof Date ? parsed.toISOString() : String(value);
}

function normalizedLinks(links, config, content) {
  const siteOrigin = new URL(config.url).origin;
  return links.map(link => {
    const target = link.target;
    if (target.startsWith('#')) return `${link.kind}|#section`;
    if (!URL.canParse(target, config.siteUrl)) throw new Error(`Invalid link target: ${target}`);
    const url = new URL(target, config.siteUrl);
    if (url.origin !== siteOrigin) return `${link.kind}|${url.origin}${url.pathname}${url.search}`;
    let pathname = url.pathname;
    const language = [...config.languages].sort((left, right) => right.path.length - left.path.length).find(value => pathname.startsWith(value.path));
    if (language) pathname = `/${pathname.slice(language.path.length)}`;
    const entry = content && content.find(value => {
      const route = value.route.startsWith('/') ? value.route : `/${value.route}`;
      return route === pathname || Object.values(value.versions).some(version => {
        const custom = version.data && version.data.permalink;
        if (!custom) return false;
        return new URL(custom, config.siteUrl).pathname === pathname;
      });
    });
    return `${link.kind}|${entry ? `content:${entry.id}` : pathname}${url.search}`;
  }).sort();
}

function validatePair(pair, sourceText, translationText, { config, content, repo } = {}) {
  const errors = [];
  if (pair.kind === 'data') {
    if (!translationText.trim()) errors.push('translation is empty');
    const definition = pair.entry && pair.entry.definition;
    if (definition && definition.validate) {
      const result = definition.validate(sourceText, translationText, { repo, config, entry: pair.entry, language: pair.language });
      if (Array.isArray(result)) errors.push(...result);
      else if (result != null) throw new Error(`${pair.id}: data validator must return an error array or undefined`);
    }
    return errors;
  }
  const source = documentSections(sourceText);
  const translation = documentSections(translationText);
  for (const field of ['published', 'comments', 'hide', 'encrypt', 'password', 'math', 'mermaid']) {
    if (JSON.stringify(source.data[field]) !== JSON.stringify(translation.data[field])) errors.push(`front matter field ${field} differs`);
  }
  for (const field of ['date', 'updated']) {
    const left = source.data[field]; const right = translation.data[field];
    if (comparableDate(left) !== comparableDate(right)) errors.push(`front matter ${field} differs`);
  }
  for (const field of ['tags', 'categories']) {
    if ([].concat(source.data[field] || []).length !== [].concat(translation.data[field] || []).length) errors.push(`front matter ${field} count differs`);
  }
  if (source.sections.length !== translation.sections.length) errors.push(`section count differs: source ${source.sections.length}, translation ${translation.sections.length}`);
  const sourceStructure = structureSignature(source.body);
  const translatedStructure = structureSignature(translation.body);
  const names = { headings: 'heading levels or order', code: 'fenced code blocks', inlineCode: 'inline code', textBlocks: 'text-like fenced blocks', tables: 'table shapes', lists: 'list structure', quotes: 'blockquote structure' };
  for (const [key, label] of Object.entries(names)) {
    if (JSON.stringify(sourceStructure[key]) !== JSON.stringify(translatedStructure[key])) errors.push(`${label} differ`);
  }
  if (mathKey(sourceStructure.math) !== mathKey(translatedStructure.math)) errors.push('math expressions differ');
  if (config && JSON.stringify(normalizedLinks(sourceStructure.links, config, content)) !== JSON.stringify(normalizedLinks(translatedStructure.links, config, content))) errors.push('link or resource targets differ');
  return errors;
}

function createRecord(repo, pair, sourceText, translationText) {
  const sourceData = pair.kind === 'data' ? {} : parseFrontMatter(sourceText).data;
  const translationData = pair.kind === 'data' ? {} : parseFrontMatter(translationText).data;
  return {
    translation: pair.translation,
    source_hash: hashText(normalizeNewlines(sourceText)), translation_hash: hashText(normalizeNewlines(translationText)),
    source_blob: repo.writeBlob(sourceText, pair.source), translation_blob: repo.writeBlob(translationText, pair.translation),
    source_meta_hash: metadataHash(sourceData), translation_meta_hash: metadataHash(translationData),
    ...(pair.kind === 'data' ? { source_sections: [], translation_sections: [] } : sectionsForRecord(sourceText, translationText))
  };
}

function checkRepository(repo, config, { lang, ids, confirmation = config.confirmation } = {}) {
  const content = enumerateContent(repo, config);
  const required = listRequiredPairs(repo, config, { lang });
  const records = confirmation ? loadRecords(repo, config) : { version: 2, contents: {} };
  const errors = [];
  const selected = ids == null ? null : new Set(ids);
  for (const pair of required) {
    if (selected && !selected.has(pair.id)) continue;
    const label = `${pair.id} (${pair.language})`;
    if (!repo.exists(pair.translation)) { errors.push(`${label}: missing translation ${pair.translation}`); continue; }
    const sourceText = repo.read(pair.source);
    const translationText = repo.read(pair.translation);
    for (const error of validatePair(pair, sourceText, translationText, { repo, config, content })) errors.push(`${label}: ${error}`);
    if (!confirmation) continue;
    const record = Object.hasOwn(records.contents, pair.id) ? records.contents[pair.id] : null;
    const baseline = record && record.translations[pair.language];
    if (!baseline) { errors.push(`${label}: missing confirmation record`); continue; }
    if (record.source !== pair.source || baseline.translation !== pair.translation) errors.push(`${label}: record paths do not match source files`);
    if (record.source_language !== pair.sourceLanguage) errors.push(`${label}: source language changed after confirmation`);
    if (baseline.source_hash !== hashText(normalizeNewlines(sourceText))) errors.push(`${label}: source changed after confirmation`);
    if (baseline.translation_hash !== hashText(normalizeNewlines(translationText))) errors.push(`${label}: translation changed after confirmation`);
    if (baseline.source_blob !== repo.blob(pair.source)) errors.push(`${label}: source baseline blob is not the current source`);
    if (baseline.translation_blob !== repo.blob(pair.translation)) errors.push(`${label}: translation baseline blob is not the current translation`);
    if (pair.kind !== 'data') {
      if (baseline.source_meta_hash !== metadataHash(parseFrontMatter(sourceText).data)) errors.push(`${label}: source metadata changed after confirmation`);
      if (baseline.translation_meta_hash !== metadataHash(parseFrontMatter(translationText).data)) errors.push(`${label}: translation metadata changed after confirmation`);
      if (JSON.stringify(baseline.source_sections) !== JSON.stringify(sectionBaselines(sourceText))) errors.push(`${label}: stale source sections`);
      if (JSON.stringify(baseline.translation_sections) !== JSON.stringify(sectionBaselines(translationText))) errors.push(`${label}: stale translation sections`);
    }
  }
  if (confirmation) {
    const allIds = new Set(content.map(entry => entry.id));
    const selectedCodes = new Set(selectLanguages(config, lang).map(language => language.code));
    for (const [id, record] of Object.entries(records.contents)) {
      if (selected && !selected.has(id)) continue;
      if (!allIds.has(id)) errors.push(`${id}: record has no required source`);
      for (const code of Object.keys(record.translations)) {
        if (!config.languages.some(language => language.code === code)) errors.push(`${id}: record has unknown language ${code}`);
        if (selectedCodes.has(code) && !required.some(pair => pair.id === id && pair.language === code)) errors.push(`${id} (${code}): record has no translation`);
      }
    }
  }
  return { errors, required: selected ? required.filter(pair => selected.has(pair.id)) : required, content, records };
}

function confirm(repo, config, { lang, ids, all = false, translated = false } = {}) {
  if (repo.rev) throw new Error('Confirmation must run against the working tree');
  const targetLanguages = selectLanguages(config);
  if (targetLanguages.length > 1 && lang == null) throw new Error('Confirmation requires --lang <code> or --lang all when several target languages are configured');
  const content = enumerateContent(repo, config);
  let required = listRequiredPairs(repo, config, { lang });
  if (translated) required = required.filter(pair => repo.exists(pair.translation));
  if (!all && !translated) {
    if (!ids || !ids.length) throw new Error('Confirmation requires content identifiers or --all');
    const selected = new Set(ids);
    for (const id of selected) {
      const entry = content.find(value => value.id === id);
      if (!entry) throw new Error(`Unknown content identity: ${id}`);
      let translations = 0;
      for (const language of selectLanguages(config, lang)) {
        const version = entry.versions[language.code];
        if (!version) throw new Error(`${id} (${language.code}): missing translation ${path.posix.join(language.source, entry.relative)}`);
        if (!version.source) translations++;
      }
      if (!translations) throw new Error(`${id}: the source version does not require translation confirmation`);
    }
    required = required.filter(pair => selected.has(pair.id));
  }
  if (!required.length) throw new Error('No translations require confirmation for this selection');
  const records = loadRecords(repo, config);
  const prepared = [];
  for (const pair of required) {
    if (!repo.exists(pair.translation)) throw new Error(`${pair.id} (${pair.language}): missing translation ${pair.translation}`);
    const sourceText = repo.read(pair.source);
    const translationText = repo.read(pair.translation);
    const errors = validatePair(pair, sourceText, translationText, { repo, config, content });
    if (errors.length) throw new Error(`${pair.id} (${pair.language}): ${errors.join(', ')}`);
    prepared.push({ pair, sourceText, translationText });
  }
  for (const { pair, sourceText, translationText } of prepared) {
    let record = Object.hasOwn(records.contents, pair.id) ? records.contents[pair.id] : null;
    if (!record) {
      record = { kind: pair.kind, source: pair.source, source_language: pair.sourceLanguage, translations: {} };
      Object.defineProperty(records.contents, pair.id, { value: record, enumerable: true, configurable: true, writable: true });
    }
    if (record.source !== pair.source || record.source_language !== pair.sourceLanguage || record.kind !== pair.kind) {
      const unselected = Object.keys(record.translations).filter(code => !prepared.some(item => item.pair.id === pair.id && item.pair.language === code));
      if (unselected.length) throw new Error(`${pair.id}: changed source identity requires confirmation of all existing languages`);
      record.kind = pair.kind; record.source = pair.source; record.source_language = pair.sourceLanguage;
    }
    record.translations[pair.language] = createRecord(repo, pair, sourceText, translationText);
  }
  writeRecords(repo, config, records);
  return prepared.map(({ pair }) => ({ id: pair.id, language: pair.language }));
}

function migrate(repo, config, { lang } = {}) {
  if (repo.rev) throw new Error('Migration must run against the working tree');
  if (!repo.exists(config.recordsPath)) throw new Error(`Missing legacy records: ${config.recordsPath}`);
  const legacy = yaml.load(repo.read(config.recordsPath));
  if (!isMapping(legacy) || legacy.version !== 1 || !isMapping(legacy.pairs)) throw new Error('Migration requires version 1 confirmation records');
  const content = enumerateContent(repo, config);
  const records = { version: 2, contents: {} };
  const languages = selectLanguages(config, lang);
  for (const [route, old] of Object.entries(legacy.pairs)) {
    if (!isMapping(old)) throw new Error(`${route}: invalid legacy record`);
    const entry = content.find(value => value.source === old.source);
    if (!entry) throw new Error(`${route}: legacy source has no content relationship`);
    if (Object.hasOwn(records.contents, entry.id)) throw new Error(`${route}: ambiguous legacy content identity ${entry.id}`);
    const candidates = languages.filter(language => entry.versions[language.code] && entry.versions[language.code].file === old.translation);
    if (candidates.length !== 1) throw new Error(`${route}: legacy translation does not identify exactly one language`);
    const language = candidates[0];
    for (const field of ['source_hash', 'translation_hash', 'source_blob', 'translation_blob', 'source_meta_hash', 'translation_meta_hash']) {
      if (typeof old[field] !== 'string' || !old[field]) throw new Error(`${route}: missing required baseline ${field}`);
    }
    const sourceBaseline = repo.readBlob(old.source_blob);
    const translatedBaseline = repo.readBlob(old.translation_blob);
    if (hashText(normalizeNewlines(sourceBaseline)) !== old.source_hash || hashText(normalizeNewlines(translatedBaseline)) !== old.translation_hash) throw new Error(`${route}: legacy blob does not match its recorded hash`);
    const sourceData = entry.kind === 'data' ? {} : parseFrontMatter(sourceBaseline).data;
    const translationData = entry.kind === 'data' ? {} : parseFrontMatter(translatedBaseline).data;
    if (metadataHash(sourceData) !== old.source_meta_hash || metadataHash(translationData) !== old.translation_meta_hash) throw new Error(`${route}: legacy metadata does not match its baseline`);
    const actualLanguage = contentLanguage(sourceData, config.defaultLanguage, old.source);
    if (contentLanguage(translationData, language.code, old.translation) !== language.code) throw new Error(`${route}: legacy translation language conflicts with target`);
    const baseline = { ...old };
    delete baseline.source; delete baseline.kind;
    delete baseline.sections;
    Object.assign(baseline, entry.kind === 'data' ? { source_sections: [], translation_sections: [] } : sectionsForRecord(sourceBaseline, translatedBaseline));
    Object.defineProperty(records.contents, entry.id, { value: { kind: entry.kind, source: old.source, source_language: actualLanguage, translations: { [language.code]: baseline } }, enumerable: true, configurable: true, writable: true });
  }
  writeRecords(repo, config, records);
  return records;
}

module.exports = { loadRecords, writeRecords, metadataFields, metadataHash, validatePair, sectionBaselines, sectionsForRecord, createRecord, checkRepository, confirm, confirmPairs: confirm, migrate };
