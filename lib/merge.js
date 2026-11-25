'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('cheerio');
const parseSrcset = require('parse-srcset');
const postcss = require('postcss');
const valueParser = require('postcss-value-parser');

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Generated output contains a symbolic link: ${file}`);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Generated output contains an unsupported file: ${file}`);
  }
  return files;
}

function mountPath(manifest, route) {
  const mounted = `${manifest.root.replace(/^\/+/, '')}${route}`;
  if (path.posix.isAbsolute(mounted) || mounted.includes('\\')
    || mounted.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe output path: ${mounted}`);
  }
  return mounted;
}

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function isShared(config, route) {
  return config.sharedAssets.some(asset => route === asset || route.startsWith(`${asset.replace(/\/$/, '')}/`));
}

function transformCssResources(stylesheet, transform) {
  const updateValue = (value, importRule = false) => {
    const parsed = valueParser(value);
    const imported = importRule ? parsed.nodes.find(node => node.type === 'string') : null;
    parsed.walk(node => {
      if (node.type === 'function' && ['image-set', '-webkit-image-set', 'image'].includes(node.value.toLowerCase())) {
        for (const resource of node.nodes.filter(child => child.type === 'string')) resource.value = transform(resource.value);
      }
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        const resource = node.nodes.find(child => child.type === 'word' || child.type === 'string');
        if (resource) resource.value = transform(resource.value);
        else transform(null);
        return false;
      }
      if (node === imported) node.value = transform(node.value);
    });
    return parsed.toString();
  };
  stylesheet.walkDecls(declaration => { declaration.value = updateValue(declaration.value); });
  stylesheet.walkAtRules('import', rule => { rule.params = updateValue(rule.params, true); });
}

function cssSignatures(config, manifests) {
  const sourceManifest = manifests.find(manifest => manifest.language === config.defaultLanguage);
  if (!sourceManifest) throw new Error('The default language build is required for stylesheet dependencies');
  const sourceRoot = new URL(sourceManifest.root, config.url).pathname;
  const origin = new URL(config.url).origin;
  const files = new Map();
  const routes = new Map(manifests.map(manifest => [manifest, new Set(manifest.routes)]));
  for (const manifest of manifests) {
    for (const route of manifest.routes) {
      files.set(new URL(`/${mountPath(manifest, route)}`, config.url).pathname, { manifest, route });
    }
  }
  const resolve = (manifest, url) => {
    if (url.pathname.startsWith(sourceRoot)) {
      const route = decodeURIComponent(url.pathname.slice(sourceRoot.length));
      if (isShared(config, route) && routes.get(manifest).has(route)) return { manifest, route };
    }
    const root = new URL(manifest.root, config.url).pathname;
    if (url.pathname.startsWith(root)) {
      const route = decodeURIComponent(url.pathname.slice(root.length));
      if (isShared(config, route) && !routes.get(manifest).has(route) && routes.get(sourceManifest).has(route)) {
        return { manifest: sourceManifest, route };
      }
    }
    return files.get(url.pathname);
  };
  const cache = new Map();
  const hashes = new Map();
  const signature = (manifest, route, visiting = new Set()) => {
    const file = path.join(manifest.output, route);
    if (!hashes.has(file)) hashes.set(file, digest(file));
    if (!/\.css$/i.test(route)) return hashes.get(file);
    if (visiting.has(file)) return `cycle:${manifest.language}:${route}`;
    if (cache.has(file)) return cache.get(file);
    const dependencies = [];
    const stylesheet = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
    const currentUrl = new URL(`/${mountPath(manifest, route)}`, config.url);
    const next = new Set([...visiting, file]);
    transformCssResources(stylesheet, value => {
      if (value == null || value.startsWith('#')) {
        dependencies.push(`context:${manifest.language}:${route}:${value}`);
        return value;
      }
      if (value.startsWith('data:')) return value;
      const url = new URL(value, currentUrl);
      if (url.origin !== origin) return value;
      const dependency = resolve(manifest, url);
      dependencies.push(dependency ? signature(dependency.manifest, dependency.route, next) : `url:${url.href}`);
      return value;
    });
    const result = crypto.createHash('sha256').update(JSON.stringify([hashes.get(file), dependencies])).digest('hex');
    cache.set(file, result);
    return result;
  };
  return signature;
}

function rewriteSharedAssets(config, manifests, outputDir, shared) {
  const defaultRoot = config.languages.find(language => language.code === config.defaultLanguage).path;
  const sourceManifest = manifests.find(manifest => manifest.language === config.defaultLanguage);
  if (!sourceManifest) throw new Error('The default language build is required for shared resources');
  const sourceResources = sourceManifest.routes.filter(route => isShared(config, route)
    && fs.existsSync(path.join(outputDir, mountPath(sourceManifest, route))));
  const rewrite = (value, currentUrl, localized) => {
    if (!value || value.startsWith('data:') || value.startsWith('#')) return value;
    const url = new URL(value, currentUrl);
    if (url.origin !== new URL(config.url).origin) return value;
    const replacement = shared.get(url.pathname) || localized.get(url.pathname);
    if (!replacement || replacement === url.pathname) return value;
    url.pathname = replacement;
    if (value.startsWith('//')) return `//${url.host}${url.pathname}${url.search}${url.hash}`;
    if (/^https?:/i.test(value)) return url.href;
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const rewriteCss = (text, currentUrl, localized, file) => {
    const stylesheet = postcss.parse(text, { from: file });
    let changed = false;
    transformCssResources(stylesheet, value => {
      const replacement = rewrite(value, currentUrl, localized);
      if (replacement !== value) changed = true;
      return replacement;
    });
    return changed ? stylesheet.toString() : text;
  };
  for (const manifest of manifests) {
    const language = config.languages.find(value => value.code === manifest.language);
    const localized = new Map(manifest.routes.filter(route => isShared(config, route)).map(route => {
      const mounted = new URL(`/${mountPath(manifest, route)}`, config.url).pathname;
      return [new URL(`${defaultRoot}${route}`, config.url).pathname, shared.get(mounted) || mounted];
    }));
    const ownRoutes = new Set(manifest.routes);
    for (const route of sourceResources) {
      if (ownRoutes.has(route)) continue;
      localized.set(new URL(`${language.path}${route}`, config.url).pathname,
        new URL(`${defaultRoot}${route}`, config.url).pathname);
    }
    for (const route of manifest.routes.filter(value => /\.(?:css|html|xml)$/i.test(value))) {
      const file = path.join(outputDir, mountPath(manifest, route));
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const currentUrl = new URL(route, language.url).href;
      let changed = false;
      if (/\.css$/i.test(route)) {
        const result = rewriteCss(text, currentUrl, localized, file);
        if (result !== text) fs.writeFileSync(file, result);
        continue;
      }
      const xml = /\.xml$/i.test(route);
      const $ = load(text, { xmlMode: xml });
      $('[style]').each((_, element) => {
        const node = $(element);
        const original = node.attr('style');
        const replacement = rewriteCss(original, currentUrl, localized, file);
        if (replacement !== original) { node.attr('style', replacement); changed = true; }
      });
      $('style').each((_, element) => {
        const node = $(element);
        const original = node.text();
        const replacement = rewriteCss(original, currentUrl, localized, file);
        if (replacement !== original) { node.text(replacement); changed = true; }
      });
      for (const attribute of ['src', 'href', 'poster', 'data-src', 'data-original', 'xlink:href']) {
        $(`[${attribute.replace(':', '\\:')}]`).each((_, element) => {
          const node = $(element);
          const original = node.attr(attribute);
          const replacement = rewrite(original, currentUrl, localized);
          if (replacement !== original) { node.attr(attribute, replacement); changed = true; }
        });
      }
      for (const attribute of ['srcset', 'data-srcset']) {
        $(`[${attribute}]`).each((_, element) => {
          const node = $(element);
          const original = node.attr(attribute);
          const candidates = parseSrcset(original);
          let replaced = false;
          for (const candidate of candidates) {
            const url = rewrite(candidate.url, currentUrl, localized);
            if (url !== candidate.url) { candidate.url = url; replaced = true; }
          }
          if (!replaced) return;
          const serialized = candidates.map(candidate => [candidate.url,
            candidate.w && `${candidate.w}w`, candidate.h && `${candidate.h}h`, candidate.d && `${candidate.d}x`]
            .filter(Boolean).join(' ')).join(', ');
          node.attr(attribute, serialized);
          changed = true;
        });
      }
      if (xml) {
        $('image\\:loc,video\\:thumbnail_loc').each((_, element) => {
          const node = $(element);
          const original = node.text();
          const replacement = rewrite(original, currentUrl, localized);
          if (replacement !== original) { node.text(replacement); changed = true; }
        });
        $('description,content\\:encoded').each((_, element) => {
          const node = $(element);
          const original = node.text();
          const fragment = load(original, null, false);
          let updated = false;
          for (const attribute of ['src', 'href', 'poster', 'data-src']) {
            fragment(`[${attribute}]`).each((_, child) => {
              const resource = fragment(child);
              const before = resource.attr(attribute);
              const after = rewrite(before, currentUrl, localized);
              if (before !== after) { resource.attr(attribute, after); updated = true; }
            });
          }
          if (updated) { node.text(fragment.html()); changed = true; }
        });
      }
      if (changed) fs.writeFileSync(file, $.html());
    }
  }
}

function mergeSitemaps(files, output) {
  const entries = new Map();
  const namespaces = new Map([['xmlns', 'http://www.sitemaps.org/schemas/sitemap/0.9']]);
  for (const file of files) {
    const $ = load(fs.readFileSync(file, 'utf8'), { xmlMode: true });
    const roots = $('urlset');
    if (roots.length !== 1) throw new Error(`Sitemap must contain one urlset: ${file}`);
    for (const [name, value] of Object.entries(roots.get(0).attribs)) {
      if (namespaces.has(name) && namespaces.get(name) !== value) throw new Error(`Conflicting sitemap attribute ${name}`);
      namespaces.set(name, value);
    }
    roots.children('url').each((_, element) => {
      const node = $(element);
      const loc = node.children('loc').text();
      if (!loc) throw new Error(`Sitemap entry has no loc: ${file}`);
      new URL(loc);
      if (!entries.has(loc)) entries.set(loc, $.html(element));
    });
  }
  const $ = load('<?xml version="1.0" encoding="UTF-8"?><urlset/>', { xmlMode: true });
  const root = $('urlset');
  for (const [name, value] of namespaces) root.attr(name, value);
  for (const [, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) root.append(entry);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${$.xml()}\n`);
}

async function mergeBuilds(config, manifests, outputDir) {
  if (!manifests.length) throw new Error('No language builds to merge');
  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.readdirSync(outputDir).length) throw new Error(`Merge directory is not empty: ${outputDir}`);
  const destinations = new Map();
  const assets = new Map();
  const shared = new Map();
  const stylesheetSignature = cssSignatures(config, manifests);
  const ordered = [...manifests].sort((left, right) => Number(right.language === config.defaultLanguage) - Number(left.language === config.defaultLanguage));
  for (const manifest of ordered) {
    if (!fs.existsSync(manifest.output)) throw new Error(`Missing language output: ${manifest.output}`);
    const actual = walk(manifest.output).map(file => path.relative(manifest.output, file).split(path.sep).join('/')).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...manifest.routes].sort())) {
      throw new Error(`Generated files differ from route manifest: ${manifest.language}`);
    }
    for (const route of manifest.routes) {
      const mounted = mountPath(manifest, route);
      if (destinations.has(mounted)) throw new Error(`Duplicate output path ${mounted}: ${destinations.get(mounted)} and ${manifest.language}`);
      destinations.set(mounted, manifest.language);
      const source = path.join(manifest.output, route);
      const target = path.join(outputDir, mounted);
      if (isShared(config, route)) {
        const hash = /\.css$/i.test(route) ? stylesheetSignature(manifest, route) : digest(source);
        const key = `${route}\0${hash}`;
        const owner = assets.get(key);
        if (owner) {
          shared.set(new URL(`/${mounted}`, config.url).pathname, new URL(`/${owner}`, config.url).pathname);
          continue;
        }
        assets.set(key, mounted);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  rewriteSharedAssets(config, manifests, outputDir, shared);
  const sitemaps = manifests.map(manifest => path.join(outputDir, mountPath(manifest, 'sitemap.xml'))).filter(file => fs.existsSync(file));
  if (sitemaps.length) {
    const defaultManifest = manifests.find(manifest => manifest.language === config.defaultLanguage) || manifests[0];
    mergeSitemaps(sitemaps, path.join(outputDir, mountPath(defaultManifest, 'sitemap.xml')));
  }
  const { enrichPages } = require('./pages');
  await enrichPages(config, manifests, outputDir);
  for (const extension of config.extensions) {
    if (extension.merge) await extension.merge({ config, manifests, outputDir });
  }
  walk(outputDir);
  return { outputDir, sharedAssets: Object.fromEntries(shared) };
}

function publishOutput(mergedRoot, outputDir) {
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  const prepared = fs.mkdtempSync(path.join(path.dirname(outputDir), '.hexo-i18n-output-'));
  for (const entry of fs.readdirSync(mergedRoot)) {
    fs.cpSync(path.join(mergedRoot, entry), path.join(prepared, entry), { recursive: true, errorOnExist: true, force: false });
  }
  const backup = `${outputDir}.i18n-backup-${crypto.randomUUID()}`;
  const hadOutput = fs.existsSync(outputDir);
  if (hadOutput) fs.renameSync(outputDir, backup);
  try {
    fs.renameSync(prepared, outputDir);
  } catch (error) {
    if (hadOutput) fs.renameSync(backup, outputDir);
    throw error;
  }
  if (hadOutput) fs.rmSync(backup, { recursive: true });
}

module.exports = { walk, mountPath, mergeSitemaps, rewriteSharedAssets, mergeBuilds, publishOutput };
