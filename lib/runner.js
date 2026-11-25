'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { readConfig } = require('./config');

function safeRoute(route) {
  if (typeof route !== 'string' || route.includes('\\') || path.posix.isAbsolute(route)
    || path.posix.normalize(route) !== route || route.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe generated route: ${route}`);
  }
  return route;
}

function collectManifest(hexo, job) {
  const contents = {};
  const seen = new Map();
  const models = [hexo.locals.get('all_posts') || hexo.locals.get('posts'), hexo.locals.get('pages')];
  for (const model of models) {
    for (const item of model.toArray()) {
      const route = safeRoute(hexo.route.format(item.path));
      const file = path.relative(job.config.baseDir, item.full_source).split(path.sep).join('/');
      if (seen.has(route)) throw new Error(`Duplicate content route ${route}: ${seen.get(route)} and ${file}`);
      seen.set(route, file);
      const entry = job.contents.find(content => Object.values(content.versions).some(version =>
        version.file === file && version.siteLanguage === job.language.code));
      if (!entry) continue;
      const version = Object.values(entry.versions).find(value => value.file === file && value.siteLanguage === job.language.code);
      contents[entry.id] = {
        route,
        url: new URL(route.replace(/(^|\/)index\.html$/, '$1'), job.language.url).href,
        file,
        language: version.language,
        kind: entry.kind,
        data: version.data,
        source: item.source,
        path: item.path
      };
    }
  }
  for (const entry of job.contents.filter(content => content.kind === 'data')) {
    const version = Object.values(entry.versions).find(value => value.siteLanguage === job.language.code);
    if (!version || !entry.route) continue;
    const route = safeRoute(hexo.route.format(entry.route));
    contents[entry.id] = { route, url: new URL(entry.route, job.language.url).href,
      file: version.file, language: version.language, kind: entry.kind, data: version.data, path: entry.route };
  }
  return { language: job.language.code, root: job.language.path, output: job.output,
    contents, routes: hexo.route.list().map(safeRoute).sort() };
}

function validateGenerators(hexo) {
  const validation = hexo.i18nRouteValidation || { paths: new Map(), generators: new Map() };
  hexo.i18nRouteValidation = validation;
  validation.paths.clear();
  for (const [name, generator] of Object.entries(hexo.extend.generator.list())) {
    if (validation.generators.get(name) === generator) continue;
    hexo.extend.generator.register(name, async function(locals) {
      const results = await generator.call(this, locals);
      if (!results) return results;
      for (const result of [].concat(results)) {
        if (!result || result.path == null) continue;
        const route = safeRoute(hexo.route.format(result.path));
        if (validation.paths.has(route)) throw new Error(`Duplicate output route ${route}: ${validation.paths.get(route)} and ${name}`);
        validation.paths.set(route, name);
      }
      return results;
    });
    validation.generators.set(name, hexo.extend.generator.get(name));
  }
}

function validateContentRoutes(hexo) {
  const seen = new Map();
  for (const name of ['posts', 'pages']) {
    const locals = name === 'posts' ? hexo.locals.get('all_posts') || hexo.locals.get('posts') : hexo.locals.get(name);
    for (const item of locals.toArray()) {
      const route = safeRoute(hexo.route.format(item.path));
      if (seen.has(route)) throw new Error(`Duplicate content route ${route}: ${seen.get(route)} and ${item.source}`);
      seen.set(route, item.source);
    }
  }
}

async function run(jobFile = process.env.HEXO_I18N_JOB) {
  if (!jobFile) throw new Error('HEXO_I18N_JOB is required');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const siteRequire = createRequire(path.join(job.config.baseDir, 'package.json'));
  const Hexo = siteRequire('hexo');
  const hexo = new Hexo(job.config.baseDir, { config: job.configFile, output: job.stage, _: ['generate'] });
  hexo.i18nConfig = readConfig({ baseDir: job.config.baseDir, hexoConfig: job.config.hexoConfig });
  hexo.i18nContents = job.contents;
  await hexo.init();
  if (!hexo.env.init) throw new Error('The site package.json must declare its Hexo version');
  hexo.extend.filter.register('before_generate', function() {
    hexo.i18nManifest = collectManifest(hexo, job);
  }, 1);
  hexo.extend.filter.register('before_generate', function() {
    validateGenerators(hexo);
  }, 1000);
  if (job.routesOnly) await hexo.load();
  else await hexo.call('generate', { bail: true });
  const manifest = collectManifest(hexo, job);
  if (!manifest.routes.length) throw new Error(`${job.language.code} generated no output routes`);
  for (const content of Object.values(manifest.contents)) {
    if (!manifest.routes.includes(content.route)) throw new Error(`Content has no generated route: ${content.file}`);
  }
  if (!job.routesOnly) {
    for (const route of manifest.routes) {
      if (!fs.statSync(path.join(job.output, route)).isFile()) throw new Error(`Missing generated file: ${route}`);
    }
  }
  fs.writeFileSync(job.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await hexo.exit();
  return manifest;
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}

module.exports = { run, collectManifest, safeRoute, validateGenerators, validateContentRoutes };
