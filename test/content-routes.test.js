'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');
const { readConfig } = require('../lib/config');
const { Repository } = require('../lib/repository');
const { enumerateContent } = require('../lib/content');
const { createContentRoutes } = require('../lib/content-routes');
const { checkRepository } = require('../lib/records');
const { build } = require('../lib/build');

let fixture;

function write(file, value) {
  const target = path.join(fixture.root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: fixture.root, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function article(title, key, body, extra = {}) {
  return `---\n${yaml.dump({ title, translation_key: key, date: '2026-01-01 00:00:00', ...extra })}---\n## Section\n\n${body}\n`;
}

test.before(async () => {
  fixture = { root: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hexo content routes ')) };
  const site = {
    title: 'Content routes', url: 'https://example.com/', source_dir: 'source', public_dir: 'site output',
    theme: 'minimal', permalink: 'articles/:year/:post_title/',
    multilingual: {
      default_language: 'zh-CN', confirmation: false, output_dir: 'site output', build_dir: 'build stages',
      languages: [
        { code: 'zh-CN', name: '中文', source_dir: 'source', path: '/' },
        { code: 'en', name: 'English', source_dir: 'english', path: '/read/', config: '_config.en.yml' }
      ]
    }
  };
  write('_config.yml', yaml.dump(site));
  write('_config.en.yml', yaml.dump({ permalink: 'stories/:name/' }));
  write('package.json', JSON.stringify({ name: 'content-route-fixture', private: true, hexo: { version: '7.3.0' }, dependencies: {
    hexo: '^7.3.0', 'hexo-i18n-workflow': 'file:plugin', 'hexo-renderer-ejs': '^2.0.0',
    'hexo-renderer-markdown-it': '^7.1.1', 'hexo-generator-index': '^4.0.0'
  } }));
  fs.mkdirSync(path.join(fixture.root, 'node_modules'));
  for (const dependency of ['hexo', 'hexo-renderer-ejs', 'hexo-renderer-markdown-it', 'hexo-generator-index']) {
    fs.symlinkSync(path.dirname(require.resolve(`${dependency}/package.json`)), path.join(fixture.root, 'node_modules', dependency), 'dir');
  }
  fs.symlinkSync(path.resolve(__dirname, '..'), path.join(fixture.root, 'node_modules/hexo-i18n-workflow'), 'dir');
  write('themes/minimal/_config.yml', '{}\n');
  for (const name of ['post', 'page', 'index']) write(`themes/minimal/layout/${name}.ejs`, '<!doctype html><html><head><title>Routes</title></head><body><main><%- page.content || "" %></main></body></html>');
  write('source/_posts/alpha.md', article('Source Alpha', 'alpha', '[Absolute beta](/articles/2026/source-beta/)\n\n[Relative beta](../source-beta/)\n\n[About](/about-us/)'));
  write('source/_posts/beta.md', article('Source Beta', 'beta', 'Beta.'));
  write('english/_posts/alpha-en.md', article('English Alpha', 'alpha', '[Absolute beta](/read/stories/renamed-beta/)\n\n[Relative beta](../renamed-beta/)\n\n[About](/read/translated-about/)'));
  write('english/_posts/renamed-beta.md', article('English Beta', 'beta', 'Beta.'));
  write('source/about/index.md', article('About', 'about', 'About.', { layout: 'page', permalink: 'about-us/' }));
  write('english/about/index.md', article('About', 'about', 'About.', { layout: 'page', permalink: 'translated-about/' }));
  git('init', '-q'); git('config', 'user.name', 'Hexo route tests'); git('config', 'user.email', 'hexo-routes@example.com');
  git('add', '_config.yml', '_config.en.yml', 'package.json', 'source', 'english', 'themes'); git('commit', '-qm', 'test: initialize multilingual routes');
  fixture.config = readConfig({ baseDir: fixture.root });
  fixture.repo = new Repository({ baseDir: fixture.root });
  fixture.content = enumerateContent(fixture.repo, fixture.config);
  fixture.routes = createContentRoutes(fixture.repo, fixture.config, fixture.content);
  fixture.result = await build(fixture.config);
});

test.after(() => { if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true }); });

test('checks real source and translated links with site permalink overrides and different file names', () => {
  assert.deepEqual(checkRepository(fixture.repo, fixture.config).errors, []);
  assert.equal(fixture.routes.byFile.get('source/_posts/beta.md').url, 'https://example.com/articles/2026/source-beta/');
  assert.equal(fixture.routes.byFile.get('english/_posts/renamed-beta.md').url, 'https://example.com/read/stories/renamed-beta/');
  for (const manifest of fixture.result.manifests) {
    for (const generated of Object.values(manifest.contents)) {
      const expected = fixture.routes.byFile.get(generated.file);
      assert.equal(expected.route, generated.route);
      assert.equal(expected.url, generated.url);
      assert.ok(fs.statSync(path.join(manifest.output, generated.route)).isFile());
    }
  }
});

test('prefers supplied real Hexo manifests when resolving confirmed content routes', () => {
  const routes = createContentRoutes(fixture.repo, fixture.config, fixture.content, { manifests: fixture.result.manifests });
  assert.equal(routes.byFile.get('english/about/index.md').url, 'https://example.com/read/translated-about/');
  assert.equal(routes.byUrl.get('https://example.com/articles/2026/source-beta/index.html').id, 'beta');
});

test('revision checks use the language configuration stored in the requested Git commit', () => {
  const revision = git('rev-parse', 'HEAD');
  write('_config.en.yml', yaml.dump({ permalink: 'changed/:name/' }));
  assert.match(checkRepository(fixture.repo, readConfig({ baseDir: fixture.root })).errors.join('\n'), /link or resource targets differ/);
  const repo = new Repository({ baseDir: fixture.root, rev: revision });
  assert.deepEqual(checkRepository(repo, readConfig({ baseDir: fixture.root, rev: revision })).errors, []);
  write('_config.en.yml', yaml.dump({ permalink: 'stories/:name/' }));
});
