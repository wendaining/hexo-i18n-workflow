'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');
const { Repository } = require('../lib/repository');
const { readConfig, selectLanguages } = require('../lib/config');
const { enumerateContent, listRequiredPairs, resolvePair } = require('../lib/content');
const { checkRepository, confirm, loadRecords, migrate, createRecord } = require('../lib/records');
const { parseFrontMatter, documentSections, structureSignature, extractFencedCode } = require('../lib/markdown');

function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, { third = true, partial = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo multilingual content '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), text);
  };
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.email', 'hexo-tests@example.com');
  git(directory, 'config', 'user.name', 'Hexo integration tests');
  const multilingual = {
    default_language: 'zh-CN', records: 'records/confirmations.yml', build_dir: 'build staging', output_dir: 'site output',
    languages: [
      { code: 'zh-CN', name: '中文', source_dir: 'original content', path: '/' },
      { code: 'en', name: 'English', source_dir: 'translations/en', path: '/english/', mode: partial ? 'partial' : 'full' },
      ...(third ? [{ code: 'ja', name: '日本語', source_dir: 'translations/ja', path: '/japanese/' }] : [])
    ]
  };
  const config = { url: 'https://example.com/', permalink: 'posts/:name/', multilingual };
  write('_config.yml', yaml.dump(config));
  const document = title => `---\ntitle: ${title}\ndate: 2026-01-01 00:00:00\n---\n\n## ${title}\n\n${title}\n\n\`\`\`js\nconst value = 1;\n\`\`\`\n`;
  write('original content/_posts/article.md', document('正文'));
  if (!partial) write('translations/en/_posts/article.md', document('Article'));
  if (third) write('translations/ja/_posts/article.md', document('本文'));
  return { directory, write, config, document, repo: new Repository({ baseDir: directory }), readConfig: () => readConfig({ baseDir: directory }) };
}

test('config resolves directories and custom language paths from a site path containing spaces', t => {
  const site = fixture(t);
  const config = site.readConfig();
  assert.equal(config.outputDir, path.join(site.directory, 'site output'));
  assert.equal(config.buildDir, path.join(site.directory, 'build staging'));
  assert.equal(config.languages[1].sourceDir, path.join(site.directory, 'translations/en'));
  assert.equal(config.languages[1].url, 'https://example.com/english/');
  assert.equal(config.defaultLanguage, 'zh-CN');
  assert.deepEqual(selectLanguages(config, ['all']).map(language => language.code), ['en', 'ja']);
  assert.deepEqual(selectLanguages(config, ['en,ja']).map(language => language.code), ['en', 'ja']);
  assert.throws(() => selectLanguages(config, ['all', 'en']), /cannot be combined/);
  assert.throws(() => selectLanguages(config, ['en', 'en']), /Duplicate language selectors/);
});

test('config rejects duplicate codes, source overlap, unsafe output paths, and missing overrides', t => {
  const site = fixture(t);
  const save = () => site.write('_config.yml', yaml.dump(site.config));
  site.config.multilingual.languages[1].code = 'zh-CN'; save();
  assert.throws(site.readConfig, /Duplicate language code/);
  site.config.multilingual.languages[1].code = 'en';
  site.config.multilingual.output_dir = 'original content/generated'; save();
  assert.throws(site.readConfig, /overlaps a source/);
  site.config.multilingual.output_dir = 'site output';
  site.config.multilingual.output_dir = '.git'; save();
  assert.throws(site.readConfig, /overlaps a source/);
  site.config.multilingual.output_dir = 'site output';
  site.config.multilingual.languages[1].source_dir = 'original content/en'; save();
  assert.throws(site.readConfig, /source directories must be separate/);
  site.config.multilingual.languages[1].source_dir = 'translations/en';
  site.config.multilingual.languages[1].config = 'absent.yml'; save();
  assert.throws(site.readConfig, /Missing language configuration/);
});

test('same-path and explicit translation keys create stable content identities', t => {
  const site = fixture(t);
  const document = title => site.document(title).replace('title:', 'translation_key: stable-article\npermalink: custom/route/\ntitle:');
  site.write('original content/_posts/article.md', document('原文'));
  site.write('translations/en/_posts/different-name.md', document('Article'));
  fs.unlinkSync(path.join(site.directory, 'translations/en/_posts/article.md'));
  site.write('translations/ja/_posts/article.md', document('本文'));
  const entries = enumerateContent(site.repo, site.readConfig());
  assert.equal(entries[0].id, 'stable-article');
  assert.equal(entries[0].versions.en.file, 'translations/en/_posts/different-name.md');
  site.write('original content/_posts/article.md', document('原文').replace('custom/route/', 'updated/address/'));
  assert.equal(enumerateContent(site.repo, site.readConfig())[0].id, 'stable-article');
});

test('content languages use lang overrides without creating duplicate source versions', t => {
  const site = fixture(t);
  site.write('original content/_posts/article.md', site.document('Article').replace('title:', 'lang: en\ntitle:'));
  fs.unlinkSync(path.join(site.directory, 'translations/en/_posts/article.md'));
  const config = site.readConfig();
  const entry = enumerateContent(site.repo, config)[0];
  assert.equal(entry.sourceLanguage, 'en');
  assert.equal(entry.versions.en.source, true);
  assert.equal(entry.versions.en.siteLanguage, 'zh-CN');
  assert.equal(listRequiredPairs(site.repo, config, { lang: 'en' }).length, 0);
  assert.equal(resolvePair(site.repo, config, 'article', { lang: 'en' }).translation, entry.source);
  site.write('original content/_posts/article.md', site.document('Article').replace('title:', 'lang: en\nlanguage: ja\ntitle:'));
  assert.throws(() => enumerateContent(site.repo, config), /lang and language conflict/);
});

test('content rejects duplicate identities, orphan translations and target language conflicts', t => {
  const site = fixture(t);
  site.write('original content/_posts/duplicate.md', site.document('Duplicate').replace('title:', 'translation_key: _posts/article.md\ntitle:'));
  assert.throws(() => enumerateContent(site.repo, site.readConfig()), /Duplicate content identity/);
  fs.unlinkSync(path.join(site.directory, 'original content/_posts/duplicate.md'));
  site.write('translations/en/_posts/orphan.md', site.document('Orphan'));
  assert.throws(() => enumerateContent(site.repo, site.readConfig()), /orphan translation/);
  fs.unlinkSync(path.join(site.directory, 'translations/en/_posts/orphan.md'));
  site.write('translations/en/_posts/article.md', site.document('Article').replace('title:', 'lang: ja\ntitle:'));
  assert.throws(() => enumerateContent(site.repo, site.readConfig()), /translation language conflicts/);
});

test('full coverage rejects missing versions while partial coverage checks existing versions', t => {
  const site = fixture(t, { partial: true });
  const partial = checkRepository(site.repo, site.readConfig(), { confirmation: false });
  assert.equal(partial.errors.length, 0);
  assert.deepEqual(partial.required.map(pair => pair.language), ['ja']);
  assert.equal(resolvePair(site.repo, site.readConfig(), 'article', { lang: 'en' }).translation, 'translations/en/_posts/article.md');
  site.config.multilingual.languages[1].mode = 'full';
  site.write('_config.yml', yaml.dump(site.config));
  assert.match(checkRepository(site.repo, site.readConfig(), { confirmation: false }).errors.join('\n'), /missing translation/);
});

test('confirmation preserves independent baselines for each language and never runs during checks', t => {
  const site = fixture(t);
  const config = site.readConfig();
  assert.throws(() => confirm(site.repo, config, { all: true }), /requires --lang/);
  confirm(site.repo, config, { lang: 'all', all: true });
  const previous = loadRecords(site.repo, config);
  const unchanged = fs.readFileSync(path.join(site.directory, config.recordsPath), 'utf8');
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
  assert.equal(fs.readFileSync(path.join(site.directory, config.recordsPath), 'utf8'), unchanged);
  site.write('translations/en/_posts/article.md', site.document('Updated article'));
  assert.match(checkRepository(site.repo, config).errors.join('\n'), /translation changed after confirmation/);
  confirm(site.repo, config, { lang: 'en', ids: ['_posts/article.md'] });
  const current = loadRecords(site.repo, config);
  assert.deepEqual(current.contents['_posts/article.md'].translations.ja, previous.contents['_posts/article.md'].translations.ja);
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
  site.write('original content/_posts/article.md', site.document('更新正文'));
  const errors = checkRepository(site.repo, config).errors.join('\n');
  assert.match(errors, /\(en\): source changed/);
  assert.match(errors, /\(ja\): source changed/);
});

test('revision checks load committed configuration, extension dependencies, content and records', t => {
  const site = fixture(t);
  site.write('extension.js', "module.exports = require('./extension-content.js');\n");
  site.write('extension-content.js', "module.exports = { content: [] };\n");
  site.config.multilingual.extensions = ['extension.js'];
  site.write('_config.yml', yaml.dump(site.config));
  confirm(site.repo, site.readConfig(), { lang: 'all', all: true });
  git(site.directory, 'add', '.');
  git(site.directory, 'commit', '-qm', 'test: record multilingual baselines');
  const commit = git(site.directory, 'rev-parse', 'HEAD');
  site.write('_config.yml', 'multilingual: invalid\n');
  site.write('extension-content.js', 'throw new Error("Changed extension");\n');
  site.write('translations/en/_posts/article.md', 'Changed content\n');
  const repo = new Repository({ baseDir: site.directory, rev: commit });
  const config = readConfig({ baseDir: site.directory, rev: commit });
  assert.deepEqual(checkRepository(repo, config).errors, []);
  assert.throws(() => confirm(repo, config, { lang: 'all', all: true }), /working tree/);
});

test('explicit legacy migration preserves blobs and hashes and detects unconfirmed content changes', t => {
  const site = fixture(t, { third: false });
  const config = site.readConfig();
  const pair = listRequiredPairs(site.repo, config)[0];
  const baseline = createRecord(site.repo, pair, site.repo.read(pair.source), site.repo.read(pair.translation));
  const legacy = { version: 1, pairs: { [pair.route]: { kind: pair.kind, source: pair.source, ...baseline, sections: [] } } };
  delete legacy.pairs[pair.route].source_sections; delete legacy.pairs[pair.route].translation_sections;
  site.write(config.recordsPath, yaml.dump(legacy));
  git(site.directory, 'add', '.');
  git(site.directory, 'commit', '-qm', 'test: save legacy confirmations');
  site.write(pair.source, site.document('更新正文'));
  const migrated = migrate(site.repo, config);
  const record = migrated.contents[pair.id].translations.en;
  for (const field of ['source_hash', 'translation_hash', 'source_blob', 'translation_blob', 'source_meta_hash', 'translation_meta_hash']) assert.equal(record[field], baseline[field]);
  assert.equal(record.source_sections.length, 1);
  assert.match(checkRepository(site.repo, config).errors.join('\n'), /source changed after confirmation/);
  assert.throws(() => migrate(site.repo, config), /version 1/);
});

test('migration rejects absent or inconsistent baseline blobs without modifying records', t => {
  const site = fixture(t, { third: false });
  const config = site.readConfig();
  const pair = listRequiredPairs(site.repo, config)[0];
  const baseline = createRecord(site.repo, pair, site.repo.read(pair.source), site.repo.read(pair.translation));
  const legacy = { version: 1, pairs: { [pair.route]: { kind: pair.kind, source: pair.source, ...baseline, source_hash: 'wrong' } } };
  const text = yaml.dump(legacy); site.write(config.recordsPath, text);
  assert.throws(() => migrate(site.repo, config), /does not match its recorded hash/);
  assert.equal(site.repo.read(config.recordsPath), text);
  legacy.pairs[pair.route].source_hash = baseline.source_hash;
  legacy.pairs[pair.route].source_blob = '0'.repeat(40);
  site.write(config.recordsPath, yaml.dump(legacy));
  assert.throws(() => migrate(site.repo, config), /Not a valid object name|bad file/);
});

test('Markdown structure uses parser tokens for nested fences, tables, list depth and real headings', () => {
  const text = '# Heading\n\n- Item\n\n    ```js\n    const x = 1;\n    ```\n\n    - Nested\n\n| A | B |\n| --- | --- |\n| a | b |\n\n```text\nA translated sentence.\n```\n\n$x^2$\n\n\\[ y + z \\]\n';
  const signature = structureSignature(text);
  assert.equal(signature.code[0].text, 'const x = 1;\n');
  assert.equal(signature.textBlocks.length, 1);
  assert.deepEqual(signature.tables, [2, 2]);
  assert.deepEqual(signature.math.map(value => value.trim()), ['y + z', 'x^2']);
  assert.deepEqual(structureSignature('Paragraph\n$$\n\nx + y\n$$\nTranslated prose\n$$\nz + w\n$$\n').math.map(value => value.trim()), ['x + y', 'z + w']);
  assert.ok(signature.lists.some(item => item.level > 0));
  assert.equal(extractFencedCode(text).length, 2);
  assert.equal(documentSections('Setext heading\n===\n\nParagraph\n').sections[0].level, 1);
  assert.throws(() => parseFrontMatter('---\ntitle: [\n---\nBody'), /unexpected end/);
});

test('front matter libraries parse empty headers and reject missing delimiters and non-mapping metadata', () => {
  assert.deepEqual(parseFrontMatter('---\n---\n正文\n').data, {});
  assert.equal(parseFrontMatter('---\n---\n正文\n').body, '正文\n');
  assert.equal(parseFrontMatter('---\n\n---\n正文\n').body, '正文\n');
  assert.deepEqual(parseFrontMatter(';;;\n;;;\n正文\n').data, {});
  assert.equal(parseFrontMatter('title: Legacy\n---\nBody\n').data.title, 'Legacy');
  assert.throws(() => parseFrontMatter('---\n'), /missing closing delimiter/);
  assert.throws(() => parseFrontMatter('---\n\n\n'), /missing closing delimiter/);
  assert.throws(() => parseFrontMatter('---\ntitle: Unclosed'), /missing closing delimiter/);
  assert.throws(() => parseFrontMatter('---\nfalse\n---\nBody'), /must be a mapping/);
  assert.throws(() => parseFrontMatter('---\n[invalid\n---\nBody'), /unexpected end/);
});

test('managed directories cannot contain confirmation records or language configuration files', t => {
  const site = fixture(t);
  site.config.multilingual.records = 'site output/confirmations.yml';
  site.write('_config.yml', yaml.dump(site.config));
  assert.throws(site.readConfig, /contains a persistent file/);
  site.config.multilingual.records = 'records/confirmations.yml';
  site.config.multilingual.languages[1].config = 'build staging/english.yml';
  site.write('build staging/english.yml', 'title: English\n');
  site.write('_config.yml', yaml.dump(site.config));
  assert.throws(site.readConfig, /contains a persistent file/);
});

test('Git line-ending attributes produce confirmation blobs that match working and committed files', t => {
  const site = fixture(t, { third: false });
  site.write('.gitattributes', '*.md text eol=lf\n');
  site.write('original content/_posts/article.md', site.document('正文').replace(/\n/g, '\r\n'));
  const config = site.readConfig();
  confirm(site.repo, config, { all: true });
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
  git(site.directory, 'add', '.');
  git(site.directory, 'commit', '-qm', 'test: normalize content line endings');
  const repo = new Repository({ baseDir: site.directory, rev: 'HEAD' });
  const committedConfig = readConfig({ baseDir: site.directory, rev: 'HEAD' });
  assert.deepEqual(checkRepository(repo, committedConfig).errors, []);
});

test('revision extensions resolve directory indexes and JSON dependencies from the committed tree', t => {
  const site = fixture(t);
  site.write('extension.js', "module.exports = require('./extension folder');\n");
  site.write('extension folder/index.js', "module.exports = require('../extension-data.json');\n");
  site.write('extension-data.json', '{"content": []}\n');
  site.config.multilingual.extensions = ['extension.js'];
  site.write('_config.yml', yaml.dump(site.config));
  git(site.directory, 'add', '.');
  git(site.directory, 'commit', '-qm', 'test: register directory extension');
  fs.unlinkSync(path.join(site.directory, 'extension folder/index.js'));
  site.write('extension-data.json', 'invalid current data\n');
  const config = readConfig({ baseDir: site.directory, rev: 'HEAD' });
  assert.deepEqual(config.extensions[0].content, []);
});

test('data extension validation receives the repository and preserves version relationships', t => {
  const site = fixture(t, { third: false });
  site.write('data-extension.js', `module.exports = { content: [{ id: '_data/example.json', relative: '_data/example.json', kind: 'data', route: 'example/', validate(source, target, {repo}) { const original = JSON.parse(source), translation = JSON.parse(target); return repo.exists('extension-flag.txt') && original.value === translation.value ? [] : ['data values differ']; } }] };\n`);
  site.write('extension-flag.txt', 'registered\n');
  site.write('original content/_data/example.json', '{"value": 1}\n');
  site.write('translations/en/_data/example.json', '{"value": 1}\n');
  site.config.multilingual.extensions = ['data-extension.js'];
  site.write('_config.yml', yaml.dump(site.config));
  const config = site.readConfig();
  confirm(site.repo, config, { all: true });
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
  assert.equal(enumerateContent(site.repo, config).find(entry => entry.kind === 'data').versions.en.file, 'translations/en/_data/example.json');
  site.write('translations/en/_data/example.json', '{"value": 2}\n');
  assert.match(checkRepository(site.repo, config).errors.join('\n'), /data values differ/);
});

test('explicit identifiers can use ordinary JavaScript property names', t => {
  const site = fixture(t, { third: false });
  for (const [file, title] of [['original content/_posts/article.md', '正文'], ['translations/en/_posts/article.md', 'Article']]) {
    site.write(file, site.document(title).replace('title:', 'translation_key: constructor\ntitle:'));
  }
  const config = site.readConfig();
  confirm(site.repo, config, { all: true });
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
  assert.equal(loadRecords(site.repo, config).contents.constructor.source, 'original content/_posts/article.md');
});

test('pair selection preserves explicit identifiers with leading and trailing slashes', t => {
  const site = fixture(t, { third: false });
  for (const [file, title] of [['original content/_posts/article.md', '正文'], ['translations/en/_posts/article.md', 'Article']]) {
    site.write(file, site.document(title).replace('title:', 'translation_key: /article/identity/\ntitle:'));
  }
  const config = site.readConfig();
  const pair = resolvePair(site.repo, config, '/article/identity/');
  assert.equal(pair.id, '/article/identity/');
  assert.equal(resolvePair(site.repo, config, 'article').id, '/article/identity/');
  confirm(site.repo, config, { ids: [pair.id] });
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
});

test('legacy metadata hashes remain valid with source language and custom permalink fields', t => {
  const site = fixture(t, { third: false });
  site.write('original content/_posts/article.md', site.document('正文').replace('title:', 'lang: ja\npermalink: original/address/\ntitle:'));
  site.write('translations/en/_posts/article.md', site.document('Article').replace('title:', 'language: en\npermalink: translated/address/\ntitle:'));
  const config = site.readConfig();
  const pair = listRequiredPairs(site.repo, config)[0];
  const baseline = createRecord(site.repo, pair, site.repo.read(pair.source), site.repo.read(pair.translation));
  const legacy = { version: 1, pairs: { [pair.route]: { kind: pair.kind, source: pair.source, ...baseline, sections: [] } } };
  delete legacy.pairs[pair.route].source_sections; delete legacy.pairs[pair.route].translation_sections;
  site.write(config.recordsPath, yaml.dump(legacy));
  const records = migrate(site.repo, config);
  assert.equal(records.contents[pair.id].source_language, 'ja');
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
  site.write(pair.source, site.repo.read(pair.source).replace('original/address/', 'new/address/'));
  assert.match(checkRepository(site.repo, config).errors.join('\n'), /source changed after confirmation/);
});

test('explicit confirmation rejects missing partial translations without writing records', t => {
  const site = fixture(t, { third: false, partial: true });
  const config = site.readConfig();
  assert.equal(resolvePair(site.repo, config, 'article').id, '_posts/article.md');
  assert.throws(() => confirm(site.repo, config, { ids: ['_posts/article.md'] }), /missing translation/);
  assert.equal(fs.existsSync(path.join(site.directory, config.recordsPath)), false);
});

test('confirmation selects translated versions and rejects a source-only selection', t => {
  const site = fixture(t);
  site.write('original content/_posts/article.md', site.document('Article').replace('title:', 'lang: en\ntitle:'));
  fs.unlinkSync(path.join(site.directory, 'translations/en/_posts/article.md'));
  const config = site.readConfig();
  assert.throws(() => confirm(site.repo, config, { lang: 'en', ids: ['_posts/article.md'] }), /source version does not require/);
  assert.equal(fs.existsSync(path.join(site.directory, config.recordsPath)), false);
  const confirmed = confirm(site.repo, config, { lang: 'all', ids: ['_posts/article.md'] });
  assert.deepEqual(confirmed, [{ id: '_posts/article.md', language: 'ja' }]);
  assert.deepEqual(checkRepository(site.repo, config).errors, []);
  assert.throws(() => confirm(site.repo, config, { lang: 'en', all: true }), /No translations require/);
});
