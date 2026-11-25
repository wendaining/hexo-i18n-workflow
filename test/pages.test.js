'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { load } = require('cheerio');
const Hexo = require('hexo');
const { readConfig } = require('../lib/config');
const { build } = require('../lib/build');
const { switchTarget } = require('../assets/language-menu');
const { activeLanguage, getRuntimeIndex } = require('../lib/site');
const {
  commentIdentity,
  createPageIndex,
  languageVersions,
  renderTranslationNotice,
  translationNotice
} = require('../lib/pages');

let fixture;

function write(root, file, contents) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function article(metadata, body) {
  return `---\n${yaml.dump({ title: 'Article', date: '2026-01-01 00:00:00', ...metadata })}---\n${body}\n`;
}

test.before(async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hexo i18n page '));
  fixture = { root };
  const site = {
    title: 'Language fixture', url: 'https://example.com/', language: 'zh-CN',
    source_dir: 'original content', public_dir: 'final output', theme: 'test-theme',
    permalink: 'entries/:title/',
    markdown: { render: { html: true }, anchors: { level: 1, case: 0 } },
    multilingual: {
      default_language: 'zh-CN', confirmation: false, output_dir: 'final output', build_dir: 'build stages',
      languages: [
        { code: 'zh-CN', name: '简体中文', source_dir: 'original content', path: '/' },
        { code: 'en', name: 'English', source_dir: 'english content', path: '/read/', mode: 'partial',
          notice: { text: 'See the {original} for details.', link_text: 'source article' } },
        { code: 'ja', name: '日本語', source_dir: 'japanese content', path: '/jp/', mode: 'partial' }
      ]
    }
  };
  write(root, '_config.yml', yaml.dump(site));
  write(root, 'package.json', JSON.stringify({ name: 'page-integration-fixture', private: true, hexo: { version: '7.3.0' }, dependencies: {
    hexo: '^7.3.0', 'hexo-i18n-workflow': 'file:plugin',
    'hexo-renderer-ejs': '^2.0.0', 'hexo-renderer-markdown-it': '^7.1.1', 'hexo-generator-index': '^4.0.0'
  } }));
  fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const layout = '<!doctype html><html><head><title><%= config.title %></title></head><body><nav id="navbar"><div id="navbarSupportedContent"><ul class="navbar-nav"><li class="nav-item"><a href="/">Home</a></li><li id="search-btn">Search</li><li id="color-toggle-btn">Color</li></ul></div></nav><article class="markdown-body"><%- page.content || "" %></article></body></html>';
  for (const view of ['post', 'page', 'index']) write(root, `themes/test-theme/layout/${view}.ejs`, layout);
  write(root, 'themes/test-theme/layout/page.ejs', '<!doctype html><html><head><title><%= config.title %></title></head><body><nav><ul><%- i18n_language_menu(page) %></ul></nav><main><%- page.content %></main></body></html>');
  write(root, 'themes/test-theme/_config.yml', '{}\n');
  write(root, 'original content/_posts/alpha.md', article({ translation_key: 'article-a', permalink: 'original-location/' },
    '## 中文章节\n\n[第二篇](/entries/beta/)\n\n[本文章节](/original-location/#中文章节)'));
  write(root, 'english content/_posts/different-name.md', article({ translation_key: 'article-a', permalink: 'other-address/' },
    '## English section\n\n[Second article](/entries/beta/)\n\n[This section](/original-location/#中文章节)'));
  write(root, 'japanese content/_posts/alpha.md', article({ translation_key: 'article-a', permalink: 'japanese-location/' },
    '## 日本語の章\n\n[第二の記事](/jp/entries/beta/)\n\n[この章](/original-location/#中文章节)'));
  write(root, 'original content/_posts/beta.md', article({ title: 'beta' }, '## 第二章\n\n正文。'));
  write(root, 'original content/_posts/native.md', article({ title: 'native', lang: 'en' }, '## Native English\n\nOriginal English article.'));
  write(root, 'original content/_posts/french.md', article({ title: 'french', lang: 'fr' }, '## Original français\n\nArticle en français.'));
  for (const [directory, heading] of [['original content', '中文关于'], ['english content', 'About in English'], ['japanese content', '日本語について']]) {
    write(root, `${directory}/about/index.md`, article({ title: 'About', layout: 'page' }, `## ${heading}\n\nAbout this site.`));
  }
  const config = readConfig({ baseDir: root });
  const result = await build(config);
  fixture = { root, config, result, index: createPageIndex(config, result.manifests) };
});

test.after(() => {
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('uses real multilingual routes, custom permalinks and actual source languages', () => {
  const versions = languageVersions(fixture.index, { contentId: 'article-a', language: 'en' });
  assert.deepEqual(versions.map(version => version.url), [
    'https://example.com/original-location/',
    'https://example.com/read/other-address/',
    'https://example.com/jp/japanese-location/'
  ]);
  const native = languageVersions(fixture.index, { contentId: '_posts/native.md', language: 'zh-CN' });
  assert.equal(native.length, 1);
  assert.equal(native[0].language, 'en');
  assert.equal(native[0].url, 'https://example.com/entries/native/');
  const html = load(fs.readFileSync(path.join(fixture.config.outputDir, 'entries/native/index.html'), 'utf8'));
  assert.equal(html('html').attr('lang'), 'en');
  assert.equal(html('link[hreflang="en"]').attr('href'), native[0].url);
  assert.equal(html('link[hreflang="zh-CN"]').length, 0);
  const french = languageVersions(fixture.index, { contentId: '_posts/french.md', language: 'zh-CN' });
  assert.equal(french[0].language, 'fr');
  assert.equal(french[0].name, 'fr');
});

test('inserts a dropdown while keeping navigation, search, color controls and real heading maps', () => {
  const html = load(fs.readFileSync(path.join(fixture.config.outputDir, 'read/other-address/index.html'), 'utf8'));
  assert.equal(html('#navbarSupportedContent .nav-item > a[href="/read/"]').text(), 'Home');
  assert.equal(html('#search-btn').text(), 'Search');
  assert.equal(html('#color-toggle-btn').text(), 'Color');
  assert.equal(html('.i18n-language-menu').length, 1);
  assert.equal(html('.i18n-language-toggle').text(), 'English');
  assert.equal(html('.i18n-language-toggle').attr('aria-expanded'), 'false');
  assert.ok(html('.i18n-language-options').is('[hidden]'));
  const link = html('[data-language-switch][hreflang="zh-CN"]');
  const heading = html('.markdown-body h2[id]').first().attr('id');
  const map = JSON.parse(link.attr('data-anchor-map'));
  assert.equal(map[heading], '中文章节');
  assert.equal(link.attr('href'), '/original-location/');
  assert.equal(link.attr('data-target'), '/original-location/');
  const preview = 'http://localhost:4000/read/other-address/';
  const clicked = switchTarget(link.attr('data-target'), preview, heading, map);
  const resolved = new URL(clicked, preview);
  assert.equal(resolved.origin, 'http://localhost:4000');
  assert.equal(resolved.pathname, '/original-location/');
  assert.equal(decodeURIComponent(resolved.hash.slice(1)), '中文章节');
  assert.equal(switchTarget(link.attr('data-target'), preview, 'missing-heading', map), '/original-location/');
  assert.equal(html('link[rel="canonical"]').attr('href'), 'https://example.com/read/other-address/');
  assert.equal(html('link[hreflang="x-default"]').attr('href'), 'https://example.com/original-location/');
  assert.equal(html('link[rel="alternate"][hreflang]').length, 4);
  assert.equal(html('script[data-i18n-workflow]').length, 1);
});

test('keeps valid source links for missing translations and maps existing translated headings', () => {
  const html = load(fs.readFileSync(path.join(fixture.config.outputDir, 'jp/japanese-location/index.html'), 'utf8'));
  assert.equal(html('.markdown-body a').filter((_, element) => html(element).text() === '第二の記事').attr('href'), '/entries/beta/');
  const chapter = html('.markdown-body a').filter((_, element) => html(element).text() === 'この章').attr('href');
  assert.equal(new URL(chapter, 'https://example.com/').pathname, '/jp/japanese-location/');
  assert.equal(decodeURIComponent(new URL(chapter, 'https://example.com/').hash.slice(1)), '日本語の章');
  const original = load(fs.readFileSync(path.join(fixture.config.outputDir, 'entries/beta/index.html'), 'utf8'));
  assert.equal(original('[data-language-switch]').length, 1);
  assert.equal(original('link[hreflang="ja"]').length, 0);
});

test('supports a theme helper with its own navigation and main content headings', () => {
  const html = load(fs.readFileSync(path.join(fixture.config.outputDir, 'read/about/index.html'), 'utf8'));
  assert.equal(html('#navbar').length, 0);
  assert.equal(html('.i18n-language-menu').length, 1);
  assert.equal(html('[data-language-switch]').length, 3);
  const heading = html('main h2[id]').attr('id');
  const map = JSON.parse(html('[data-language-switch][hreflang="ja"]').attr('data-anchor-map'));
  assert.equal(map[heading], '日本語について');
});

test('returns shared, independent and custom comment identities plus common HTML and Markdown notice data', () => {
  const query = { contentId: 'article-a', language: 'en' };
  const shared = commentIdentity(fixture.index, query);
  assert.deepEqual(shared, {
    contentId: 'article-a', currentLanguage: 'en',
    sourceUrl: 'https://example.com/original-location/', currentUrl: 'https://example.com/read/other-address/',
    discussionId: 'article-a'
  });
  assert.equal(commentIdentity(fixture.index, query, { mode: 'independent' }).discussionId, 'article-a:en');
  assert.equal(commentIdentity(fixture.index, query, { discussionId: identity => new URL(identity.sourceUrl).pathname.slice(1) }).discussionId, 'original-location/');
  const notice = translationNotice(fixture.index, query);
  const html = load(renderTranslationNotice(notice), null, false);
  assert.equal(html('p').text(), 'See the source article for details.');
  assert.equal(html('a').attr('href'), shared.sourceUrl);
  assert.match(renderTranslationNotice(notice, { format: 'markdown' }), /See the \[source article\]\(<https:\/\/example.com\/original-location\/>\) for details\./);
  assert.equal(translationNotice(fixture.index, { contentId: 'article-a', language: 'zh-CN' }), null);
  const incomplete = createPageIndex(fixture.config, fixture.result.manifests.filter(manifest => manifest.language !== 'zh-CN'));
  assert.throws(() => commentIdentity(incomplete, query), /Original content route is missing/);
});

test('identifies an ordinary target-language Hexo instance from its configured source directory', async () => {
  const config = {
    ...fixture.config.hexoConfig,
    language: 'en', source_dir: 'english content', root: '/read/', url: 'https://example.com/read/',
    public_dir: 'ordinary target output'
  };
  write(fixture.root, 'ordinary-target.yml', yaml.dump(config));
  fs.mkdirSync(path.join(fixture.root, 'ordinary database'));
  const hexo = new Hexo(fixture.root, {
    config: 'ordinary-target.yml', output: path.join(fixture.root, 'ordinary database'), _: ['generate']
  });
  await hexo.init();
  assert.equal(activeLanguage(hexo, fixture.config), 'en');
  await hexo.call('generate', { bail: true });
  const index = getRuntimeIndex(hexo);
  assert.equal(index.manifests[0].language, 'en');
  const versions = languageVersions(index, { contentId: 'article-a', language: 'en' });
  assert.equal(versions[0].url, 'https://example.com/read/other-address/');
  await hexo.exit();
});
