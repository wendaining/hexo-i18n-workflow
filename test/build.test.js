'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { load } = require('cheerio');
const postcss = require('postcss');
const valueParser = require('postcss-value-parser');
const { readConfig } = require('../lib/config');
const { build } = require('../lib/build');
const { clean } = require('../lib/clean');

const sharedImage = fs.readFileSync(path.join(__dirname, 'fixtures/shared.png'));
const alternateImage = fs.readFileSync(path.join(__dirname, 'fixtures/alternate.png'));

function write(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function article(title, body, extra = {}) {
  return `---\n${yaml.dump({ title, date: '2026-01-01 00:00:00', ...extra })}---\n\n${body}\n`;
}

function station(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hexo multilingual build ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dependencies = {
    hexo: '^7.3.0', 'hexo-i18n-workflow': 'file:plugins/hexo-i18n-workflow',
    'hexo-renderer-ejs': '^2.0.0', 'hexo-renderer-markdown-it': '^7.1.1', 'hexo-generator-index': '^4.0.0', cheerio: '^1.2.0'
  };
  write(root, 'package.json', JSON.stringify({ name: 'real-hexo-test-station', private: true,
    hexo: { version: '7.3.0' }, dependencies }));
  fs.mkdirSync(path.join(root, 'node_modules'));
  for (const name of Object.keys(dependencies)) {
    const directory = name === 'hexo-i18n-workflow'
      ? path.resolve(__dirname, '..') : path.dirname(require.resolve(`${name}/package.json`));
    fs.symlinkSync(directory, path.join(root, 'node_modules', name), 'dir');
  }
  const settings = {
    title: 'Source station', url: 'https://example.test/', theme: 'fixture', permalink: 'posts/:title/',
    source_dir: 'content original', public_dir: 'published output', timezone: 'UTC',
    post_asset_folder: true,
    multilingual: { default_language: 'zh-CN', confirmation: false, build_dir: 'build workspace',
      output_dir: 'published output', shared_assets: ['img'], languages: [
        { code: 'zh-CN', name: '简体中文', source_dir: 'content original', path: '/' },
        { code: 'en', name: 'English', source_dir: 'content english', path: '/english/', mode: 'partial', config: 'english.yml' },
        { code: 'de', name: 'Deutsch', source_dir: 'content german', path: '/third/', mode: 'partial', config: 'german.yml' }
      ] }
  };
  write(root, '_config.yml', yaml.dump(settings));
  write(root, 'english.yml', 'title: English station\n');
  write(root, 'german.yml', 'title: German station\n');
  write(root, 'themes/fixture/_config.yml', '{}\n');
  write(root, 'themes/fixture/layout/layout.ejs', '<!doctype html><html><head><title><%= config.title %></title><link rel="canonical" href="<%= url %>"><%- css("css/pictures.css") %></head><body><nav id="navbarSupportedContent"><ul class="navbar-nav"><li id="search-btn">Search</li><li id="color-toggle-btn">Theme</li></ul></nav><article class="markdown-body"><%- body %></article></body></html>');
  write(root, 'themes/fixture/layout/post.ejs', '<%- page.content %><script id="comment-identity" type="application/json"><%- JSON.stringify(i18n_comments(page)) %></script>');
  write(root, 'themes/fixture/layout/page.ejs', '<%- page.content %>');
  write(root, 'themes/fixture/layout/index.ejs', '<% site.posts.forEach(post => { %><a href="<%= url_for(post.path) %>"><%= post.title %></a><% }) %>');
  write(root, 'scripts/sitemap.js', `const {load}=require('cheerio');
hexo.extend.generator.register('fixture-sitemap', function(locals) {
  const $=load('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"/>',{xmlMode:true});
  for(const post of locals.posts.toArray()) {
    const entry=$('<url><loc/><image:image><image:loc/></image:image></url>');
    entry.find('loc').text(post.permalink);
    entry.find('image\\\\:loc').text(new URL('img/same.png?x=1&y=2',this.config.url+'/').href);
    $('urlset').append(entry);
  }
  return {path:'sitemap.xml',data:$.xml()};
});\n`);
  write(root, 'content original/_posts/source.md', article('原文', '## 第一章\n\n[原文](/posts/source/)\n\n<img src="/img/same.png"><img src="/img/different.png">', { translation_key: 'example' }));
  write(root, 'content english/_posts/renamed.md', article('English', '## First chapter\n\n[Source](/posts/source/)\n\n<img src="/english/img/same.png" srcset="/english/img/same.png 1x, /english/img/same.png 2x"><img src="/english/img/different.png">', { translation_key: 'example', permalink: 'essays/translated/' }));
  write(root, 'content german/_posts/anders.md', article('Deutsch', '## Erstes Kapitel\n\n[Original](/posts/source/)\n\n<img src="/third/img/same.png"><img src="/img/different.png">', { translation_key: 'example', permalink: 'artikel/beispiel/' }));
  for (const directory of ['content original', 'content english', 'content german']) {
    write(root, `${directory}/img/same.png`, sharedImage);
    write(root, `${directory}/img/different.png`, directory === 'content original' ? sharedImage : alternateImage);
    write(root, `${directory}/img/图像 space.png`, sharedImage);
    write(root, `${directory}/css/pictures.css`, ".background { background-image: url('../img/same.png'); }\n");
    write(root, `${directory}/css/unicode.css`, ".background { background-image: url('../img/图像 space.png'); }\n");
  }
  write(root, 'content original/_posts/source/figure.txt', 'Source article asset');
  write(root, 'content english/_posts/renamed/figure.txt', 'English article asset');
  write(root, 'content german/_posts/anders/figure.txt', 'German article asset');
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return { root, settings, config: () => readConfig({ baseDir: root }) };
}

test('builds three real Hexo sites with isolated paths, databases, real routes and assets', async t => {
  const fixture = station(t);
  const result = await build(fixture.config());
  assert.equal(result.manifests.length, 3);
  assert.equal(fs.existsSync(path.join(fixture.root, 'db.json')), false);
  for (const [position, code] of ['zh-CN', 'en', 'de'].entries()) {
    const stage = path.join(result.runDir, `${position}-${code}`);
    assert.equal(fs.existsSync(path.join(stage, 'db.json')), true);
    assert.equal(yaml.load(fs.readFileSync(path.join(stage, 'config.yml'), 'utf8')).language, code);
  }
  const english = result.manifests.find(manifest => manifest.language === 'en');
  assert.equal(english.contents.example.route, 'essays/translated/index.html');
  assert.equal(english.contents.example.url, 'https://example.test/english/essays/translated/');
  const output = result.outputDir;
  assert.equal(fs.existsSync(path.join(output, 'english/img/same.png')), false);
  assert.equal(fs.existsSync(path.join(output, 'third/img/same.png')), false);
  assert.ok(fs.readFileSync(path.join(output, 'img/different.png')).equals(sharedImage));
  assert.ok(fs.readFileSync(path.join(output, 'english/img/different.png')).equals(alternateImage));
  assert.equal(fs.existsSync(path.join(output, 'third/img/different.png')), false);
  assert.equal(fs.readFileSync(path.join(output, 'posts/source/figure.txt'), 'utf8'), 'Source article asset');
  assert.equal(fs.readFileSync(path.join(output, 'english/essays/translated/figure.txt'), 'utf8'), 'English article asset');
  const $ = load(fs.readFileSync(path.join(output, 'english/essays/translated/index.html'), 'utf8'));
  assert.equal($('title').text(), 'English station');
  assert.equal($('img').first().attr('src'), '/img/same.png');
  assert.equal($('img').first().attr('srcset'), '/img/same.png 1x, /img/same.png 2x');
  assert.equal($('img').last().attr('src'), '/english/img/different.png');
  const german = load(fs.readFileSync(path.join(output, 'third/artikel/beispiel/index.html'), 'utf8'));
  assert.equal(german('img').last().attr('src'), '/english/img/different.png');
  assert.equal($('#search-btn').length, 1);
  assert.equal($('#color-toggle-btn').length, 1);
  assert.equal($('link[hreflang="de"]').attr('href'), 'https://example.test/third/artikel/beispiel/');
  assert.equal($('article a').first().attr('href'), '/english/essays/translated/');
  assert.deepEqual(JSON.parse($('a[data-language-switch][hreflang="zh-CN"]').attr('data-anchor-map')), { 'First-chapter': '第一章' });
  const sitemap = load(fs.readFileSync(path.join(output, 'sitemap.xml'), 'utf8'), { xmlMode: true });
  assert.equal(sitemap('url').length, 3);
  assert.equal(sitemap('image\\:image').length, 3);
  assert.match(sitemap('image\\:loc').first().text(), /\?x=1&y=2$/);
  assert.ok(sitemap('image\\:loc').toArray().every(element => new URL(sitemap(element).text()).pathname === '/img/same.png'));
  assert.match(fs.readFileSync(path.join(output, 'english/css/pictures.css'), 'utf8'), /url\('\/img\/same.png'\)/);
  assert.match(fs.readFileSync(path.join(output, 'third/css/pictures.css'), 'utf8'), /url\('\/img\/same.png'\)/);
  assert.equal(fs.existsSync(path.join(output, 'english/img/图像 space.png')), false);
  assert.ok(fs.readFileSync(path.join(output, 'img/图像 space.png')).equals(sharedImage));
  assert.match(fs.readFileSync(path.join(output, 'english/css/unicode.css'), 'utf8'), /url\('\/img\/%E5%9B%BE%E5%83%8F%20space.png'\)/);
});

test('uses existing shared source resources for translated pages, scripts and background styles', async t => {
  const fixture = station(t);
  fixture.settings.multilingual.shared_assets = ['img', 'css', 'js'];
  write(fixture.root, '_config.yml', yaml.dump(fixture.settings));
  write(fixture.root, 'content original/img/bg/original.png', sharedImage);
  write(fixture.root, 'content original/css/custom.css', ".logo { background-image: url('../img/bg/original.png'); }\n");
  write(fixture.root, 'content original/js/source-only.js', "document.documentElement.dataset.sharedResource = 'ready';\n");
  write(fixture.root, 'content english/css/target-only.css', ".translated { background-image: url('../img/bg/original.png'); }\n");
  write(fixture.root, 'themes/fixture/layout/layout.ejs', '<!doctype html><html><head><title><%= config.title %></title><%- css("css/custom.css") %><%- js("js/source-only.js") %><style>.banner { background-image: url("<%= url_for("img/bg/original.png") %>"); }</style></head><body><nav id="navbarSupportedContent"><ul class="navbar-nav"></ul></nav><div id="hero" style="background-image: url(\'<%= url_for("img/bg/original.png") %>\'); color: red"></div><img id="source-image" src="<%= url_for("img/bg/original.png?v=1#cover") %>"><article class="markdown-body"><%- body %></article></body></html>');
  const result = await build(fixture.config());
  const html = load(fs.readFileSync(path.join(result.outputDir, 'english/essays/translated/index.html'), 'utf8'));
  assert.equal(html('link[href="/css/custom.css"]').length, 1);
  assert.equal(html('script[src="/js/source-only.js"]').length, 1);
  assert.equal(html('#source-image').attr('src'), '/img/bg/original.png?v=1#cover');
  assert.match(html('#hero').attr('style'), /url\('\/img\/bg\/original.png'\)/);
  assert.match(html('style').text(), /url\("\/img\/bg\/original.png"\)/);
  assert.equal(html('article img').last().attr('src'), '/english/img/different.png');
  assert.ok(fs.readFileSync(path.join(result.outputDir, 'english/img/different.png')).equals(alternateImage));
  assert.ok(fs.readFileSync(path.join(result.outputDir, 'img/bg/original.png')).equals(sharedImage));
  assert.equal(fs.existsSync(path.join(result.outputDir, 'english/img/bg/original.png')), false);
  assert.match(fs.readFileSync(path.join(result.outputDir, 'english/css/target-only.css'), 'utf8'), /url\('\/img\/bg\/original.png'\)/);
});

test('shares identical stylesheets only when their relative resources and imports match', async t => {
  const fixture = station(t);
  fixture.settings.multilingual.shared_assets = ['img', 'css'];
  write(fixture.root, '_config.yml', yaml.dump(fixture.settings));
  for (const directory of ['content original', 'content english', 'content german']) {
    write(fixture.root, `${directory}/css/dependent.css`, ".hero { background-image: url('../img/different.png'); }\n.second { background-image: image-set('../img/different.png' 1x); }\n");
    write(fixture.root, `${directory}/css/imported.css`, "@import './dependent.css';\n");
  }
  write(fixture.root, 'themes/fixture/layout/layout.ejs', '<!doctype html><html><head><title><%= config.title %></title><%- css("css/dependent.css") %><%- css("css/imported.css") %><%- css("css/pictures.css") %></head><body><nav id="navbarSupportedContent"><ul class="navbar-nav"></ul></nav><article class="markdown-body"><%- body %></article></body></html>');
  const result = await build(fixture.config());
  const english = load(fs.readFileSync(path.join(result.outputDir, 'english/essays/translated/index.html'), 'utf8'));
  assert.equal(english('link[href="/english/css/dependent.css"]').length, 1);
  assert.equal(english('link[href="/english/css/imported.css"]').length, 1);
  assert.equal(english('link[href="/css/pictures.css"]').length, 1);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'english/css/pictures.css')), false);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'english/css/dependent.css')), true);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'english/css/imported.css')), true);
  const german = load(fs.readFileSync(path.join(result.outputDir, 'third/artikel/beispiel/index.html'), 'utf8'));
  assert.equal(german('link[href="/english/css/dependent.css"]').length, 1);
  assert.equal(german('link[href="/english/css/imported.css"]').length, 1);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'third/css/dependent.css')), false);
  assert.ok(fs.readFileSync(path.join(result.outputDir, 'img/different.png')).equals(sharedImage));
  assert.ok(fs.readFileSync(path.join(result.outputDir, 'english/img/different.png')).equals(alternateImage));
  const stylesheet = postcss.parse(fs.readFileSync(path.join(result.outputDir, 'english/css/dependent.css'), 'utf8'));
  let reference;
  stylesheet.walkDecls('background-image', declaration => {
    valueParser(declaration.value).walk(node => {
      if (node.type === 'function' && node.value === 'url') reference = node.nodes[0].value;
    });
  });
  const resource = new URL(reference, 'https://example.test/english/css/dependent.css');
  assert.equal(resource.pathname, '/english/img/different.png');
  assert.ok(fs.readFileSync(path.join(result.outputDir, resource.pathname)).equals(alternateImage));
});

test('rejects duplicate true permalinks before publishing and preserves existing output', async t => {
  const fixture = station(t);
  write(fixture.root, 'published output/keep.txt', 'Current complete output');
  write(fixture.root, 'content original/_posts/collision.md', article('Collision', '## Heading', { permalink: 'posts/source/' }));
  await assert.rejects(build(fixture.config()), /Duplicate content route/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'published output/keep.txt'), 'utf8'), 'Current complete output');
});

test('rejects duplicate generator output from a real Hexo generator', async t => {
  const fixture = station(t);
  write(fixture.root, 'scripts/collision.js', "hexo.extend.generator.register('collision', () => ({path:'index.html',data:'Collision'}));\n");
  await assert.rejects(build(fixture.config(), { lang: 'zh-CN' }), /Duplicate output route/);
});

test('rejects collisions between language mounts and preserves existing output', async t => {
  const fixture = station(t);
  write(fixture.root, 'published output/keep.txt', 'Current complete output');
  write(fixture.root, 'content original/english/index.md', article('English path', '## Heading'));
  await assert.rejects(build(fixture.config()), /Duplicate output path english\/index.html/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'published output/keep.txt'), 'utf8'), 'Current complete output');
});

test('rejects a real plugin load error even when Hexo completes generation', async t => {
  const fixture = station(t);
  write(fixture.root, 'published output/keep.txt', 'Current complete output');
  write(fixture.root, 'scripts/error.js', "require('./required-file-that-is-absent');\n");
  await assert.rejects(build(fixture.config(), { lang: 'zh-CN' }), /required-file-that-is-absent/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'published output/keep.txt'), 'utf8'), 'Current complete output');
});

test('rejects a real merge extension error without publishing partial output', async t => {
  const fixture = station(t);
  write(fixture.root, 'published output/keep.txt', 'Current complete output');
  write(fixture.root, 'extensions/missing-input.js', "const fs = require('node:fs'); module.exports={merge({config}){fs.readFileSync(require('node:path').join(config.baseDir,'missing-input.txt'));}};\n");
  fixture.settings.multilingual.extensions = ['extensions/missing-input.js'];
  write(fixture.root, '_config.yml', yaml.dump(fixture.settings));
  await assert.rejects(build(fixture.config(), { lang: 'zh-CN' }), /ENOENT/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'published output/keep.txt'), 'utf8'), 'Current complete output');
});

test('builds a selected language and cleans only configured managed directories', async t => {
  const fixture = station(t);
  write(fixture.root, 'unmanaged-output/keep.txt', 'Unmanaged output');
  const config = fixture.config();
  const result = await build(config, { lang: 'de' });
  assert.deepEqual(result.manifests.map(manifest => manifest.language), ['zh-CN', 'de']);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'third/artikel/beispiel/index.html')), true);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'index.html')), true);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'english/index.html')), false);
  const html = load(fs.readFileSync(path.join(result.outputDir, 'third/artikel/beispiel/index.html'), 'utf8'));
  assert.equal(html('link[hreflang="x-default"]').attr('href'), 'https://example.test/posts/source/');
  assert.equal(JSON.parse(html('#comment-identity').text()).sourceUrl, 'https://example.test/posts/source/');
  clean(config);
  assert.equal(fs.existsSync(config.outputDir), false);
  assert.equal(fs.existsSync(config.buildDir), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'content original/_posts/source.md')), true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'unmanaged-output/keep.txt')), true);
});

test('full coverage uses an original already in the target language and rejects a missing version', async t => {
  const fixture = station(t);
  fixture.settings.multilingual.languages[1].mode = 'full';
  write(fixture.root, '_config.yml', yaml.dump(fixture.settings));
  write(fixture.root, 'content original/_posts/native.md', article('Native', '## Native English\n\nThis is the original article.', { lang: 'en' }));
  const result = await build(fixture.config());
  assert.equal(fs.existsSync(path.join(result.outputDir, 'posts/native/index.html')), true);
  assert.equal(fs.existsSync(path.join(result.outputDir, 'english/posts/native/index.html')), false);
  const html = load(fs.readFileSync(path.join(result.outputDir, 'posts/native/index.html'), 'utf8'));
  assert.equal(html('html').attr('lang'), 'en');
  assert.equal(html('link[hreflang="en"]').attr('href'), 'https://example.test/posts/native/');
  assert.equal(html('link[hreflang="zh-CN"]').length, 0);
  const original = fs.readFileSync(path.join(result.outputDir, 'posts/native/index.html'), 'utf8');
  write(fixture.root, 'content original/_posts/untranslated.md', article('Untranslated', '## Missing translation'));
  await assert.rejects(build(fixture.config()), /missing translation content english\/_posts\/untranslated.md/);
  assert.equal(fs.readFileSync(path.join(result.outputDir, 'posts/native/index.html'), 'utf8'), original);
});

test('renders comments from real source routes when source language is configured after targets', async t => {
  const fixture = station(t);
  fixture.settings.multilingual.languages.push(fixture.settings.multilingual.languages.shift());
  write(fixture.root, '_config.yml', yaml.dump(fixture.settings));
  const result = await build(fixture.config());
  const english = load(fs.readFileSync(path.join(result.outputDir, 'english/essays/translated/index.html'), 'utf8'));
  assert.equal(JSON.parse(english('#comment-identity').text()).sourceUrl, 'https://example.test/posts/source/');
  assert.equal(JSON.parse(english('#comment-identity').text()).discussionId, 'example');
  assert.equal(english('link[hreflang="x-default"]').attr('href'), 'https://example.test/posts/source/');
  assert.deepEqual(result.manifests.map(manifest => manifest.language), ['en', 'de', 'zh-CN']);
  assert.equal(fs.readdirSync(path.join(result.runDir, 'source-routes-zh-CN/public')).length, 0);
  assert.equal(fs.existsSync(path.join(result.runDir, 'source-routes-zh-CN/db.json')), true);
});

test('records and renders hidden public articles from a real Hexo visibility extension', async t => {
  const fixture = station(t);
  for (const directory of ['content original', 'content english', 'content german']) {
    write(fixture.root, `${directory}/_posts/hidden.md`, article('Hidden public article', '## Section\n\nPublic content outside the index.', { hide: true }));
  }
  write(fixture.root, 'scripts/visibility.js', `hexo.extend.filter.register('before_generate', function() {
  const posts=this.locals.get('posts');
  this.locals.set('all_posts',posts);
  this.locals.set('posts',posts.filter(post=>!post.hide));
});
hexo.extend.generator.register('hidden-public-articles',function(locals) {
  return locals.all_posts.filter(post=>post.hide).map(post=>({path:post.path,layout:'post',data:post}));
});\n`);
  const result = await build(fixture.config());
  for (const manifest of result.manifests) {
    const entry = manifest.contents['_posts/hidden.md'];
    assert.equal(entry.route, 'posts/hidden/index.html');
    assert.equal(entry.data.hide, true);
    const html = load(fs.readFileSync(path.join(result.outputDir, manifest.root, entry.route), 'utf8'));
    assert.equal(JSON.parse(html('#comment-identity').text()).sourceUrl, 'https://example.test/posts/hidden/');
  }
  const homepage = fs.readFileSync(path.join(result.outputDir, 'index.html'), 'utf8');
  assert.doesNotMatch(homepage, /Hidden public article/);
});

test('rejects source overlap, symlinked output and unmanaged build directories', t => {
  const fixture = station(t);
  const config = fixture.config();
  assert.throws(() => clean({ ...config, outputDir: config.languages[0].sourceDir }), /overlaps/);
  fs.symlinkSync(config.languages[0].sourceDir, path.join(fixture.root, 'symbolic-output'), 'dir');
  assert.throws(() => clean({ ...config, outputDir: path.join(fixture.root, 'symbolic-output') }), /symbolic link|overlaps/);
  write(fixture.root, 'build workspace/unmanaged.txt', 'Unmanaged files');
  assert.throws(() => clean(config), /not managed/);
  assert.equal(fs.existsSync(path.join(config.buildDir, 'unmanaged.txt')), true);
  write(fixture.root, 'build workspace/.hexo-i18n-workflow', '/another-site\n');
  assert.throws(() => require('../lib/clean').prepareBuildDirectory(config), /not managed/);
  assert.equal(fs.readFileSync(path.join(config.buildDir, '.hexo-i18n-workflow'), 'utf8'), '/another-site\n');
});

test('ordinary Hexo generate rejects unconfirmed content and route conflicts', t => {
  const fixture = station(t);
  fixture.settings.multilingual.confirmation = true;
  write(fixture.root, '_config.yml', yaml.dump(fixture.settings));
  const command = [path.join(fixture.root, 'node_modules/hexo/bin/hexo'), 'generate', '--bail'];
  let result = spawnSync(process.execPath, command, { cwd: fixture.root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /missing confirmation record/);
  fixture.settings.multilingual.confirmation = false;
  write(fixture.root, '_config.yml', yaml.dump(fixture.settings));
  write(fixture.root, 'scripts/collision.js', "hexo.extend.generator.register('collision', () => ({path:'index.html',data:'Collision'}));\n");
  result = spawnSync(process.execPath, command, { cwd: fixture.root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Duplicate output route/);
  fs.unlinkSync(path.join(fixture.root, 'scripts/collision.js'));
  write(fixture.root, 'scripts/error.js', "require('./required-file-that-is-absent');\n");
  result = spawnSync(process.execPath, command, { cwd: fixture.root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /ERROR/);
  assert.match(result.stdout + result.stderr, /required-file-that-is-absent/);
});

test('installs a packed plugin outside the repository and builds three real Hexo languages', { timeout: 180000 }, async t => {
  const fixture = station(t);
  fs.rmSync(path.join(fixture.root, 'node_modules'), { recursive: true });
  const packed = spawnSync('npm', ['pack', path.resolve(__dirname, '..'), '--pack-destination', fixture.root, '--json'], {
    cwd: fixture.root, encoding: 'utf8', timeout: 60000
  });
  assert.equal(packed.status, 0, packed.stderr);
  const filename = JSON.parse(packed.stdout)[0].filename;
  const packageFile = path.join(fixture.root, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  metadata.dependencies.hexo = '7.3.0';
  metadata.dependencies['hexo-i18n-workflow'] = `file:./${filename}`;
  fs.writeFileSync(packageFile, JSON.stringify(metadata));
  const installed = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: fixture.root, encoding: 'utf8', timeout: 120000
  });
  assert.equal(installed.status, 0, installed.stderr);
  const plugin = path.join(fixture.root, 'node_modules/hexo-i18n-workflow');
  assert.equal(fs.lstatSync(plugin).isSymbolicLink(), false);
  const generated = spawnSync(process.execPath, [path.join(plugin, 'bin/cli.js'), 'build'], {
    cwd: fixture.root, encoding: 'utf8', timeout: 60000
  });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  for (const route of ['posts/source/index.html', 'english/essays/translated/index.html', 'third/artikel/beispiel/index.html']) {
    assert.equal(fs.existsSync(path.join(fixture.root, 'published output', route)), true, route);
  }
  const manifests = fs.readdirSync(path.join(fixture.root, 'build workspace')).filter(name => name.startsWith('run-'));
  assert.equal(manifests.length, 1);
  const records = JSON.parse(fs.readFileSync(path.join(fixture.root, 'build workspace', manifests[0], 'manifests.json'), 'utf8'));
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.language), ['zh-CN', 'en', 'de']);
});
