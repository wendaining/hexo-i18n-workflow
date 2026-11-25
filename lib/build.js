'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');
const yaml = require('js-yaml');
const { readConfig, mergeConfig, selectLanguages } = require('./config');
const { Repository } = require('./repository');
const { enumerateContent } = require('./content');
const { prepareBuildDirectory } = require('./clean');
const { mergeBuilds, publishOutput } = require('./merge');

function runLanguage(job, priorManifestFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'runner.js')], {
      cwd: job.config.baseDir,
      env: { ...process.env, HEXO_I18N_JOB: job.jobFile, HEXO_I18N_LANGUAGE: job.language.code,
        HEXO_I18N_MANIFESTS: priorManifestFile, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    const record = (stream, chunk) => { logs += chunk.toString(); stream.write(chunk); };
    child.stdout.on('data', chunk => record(process.stdout, chunk));
    child.stderr.on('data', chunk => record(process.stderr, chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const cleanLogs = stripVTControlCharacters(logs);
      fs.writeFileSync(path.join(job.stage, 'build.log'), cleanLogs);
      if (code !== 0) {
        const lines = cleanLogs.split('\n');
        const cause = lines.find(line => /^\w*Error:/.test(line)) || lines.find(line => /^(?:ERROR|FATAL)\b/.test(line));
        reject(new Error(`${job.language.code} build failed with ${signal || `exit code ${code}`}${cause ? `: ${cause}` : ''}`));
        return;
      }
      if (/^\s*(?:\d{2}:\d{2}:\d{2}\.\d{3}\s+)?(?:ERROR|FATAL)\b/m.test(cleanLogs)) {
        reject(new Error(`${job.language.code} build logged ERROR or FATAL`));
        return;
      }
      resolve();
    });
  }).then(() => JSON.parse(fs.readFileSync(job.manifestFile, 'utf8')));
}

function prepareLanguage(config, contents, runDir, index, language, routesOnly = false) {
  const stage = path.join(runDir, `${index}-${language.code}`);
  const output = path.join(stage, 'public');
  fs.mkdirSync(output, { recursive: true });
  const override = language.configFile ? yaml.load(fs.readFileSync(language.configFile, 'utf8')) : {};
  const merged = mergeConfig(mergeConfig(config.hexoConfig, override), {
    language: language.code, url: language.url, root: language.path,
    source_dir: language.sourceDir, public_dir: output,
    multilingual: { current_language: language.code }
  });
  const configFile = path.join(stage, 'config.yml');
  fs.writeFileSync(configFile, yaml.dump(merged, { noRefs: true, lineWidth: -1 }));
  const job = { config, language, contents, stage, output, configFile, routesOnly,
    manifestFile: path.join(stage, 'routes.json'), jobFile: path.join(stage, 'job.json') };
  fs.writeFileSync(job.jobFile, JSON.stringify(job));
  return job;
}

async function build(config = readConfig(), options = {}) {
  const selected = selectLanguages(config, options.lang, { targets: false });
  const languages = config.languages.filter(language => language.code === config.defaultLanguage
    || selected.some(value => value.code === language.code));
  const repo = new Repository({ baseDir: config.baseDir });
  const { checkRepository } = require('./records');
  const check = checkRepository(repo, config, { lang: languages.filter(language => language.code !== config.defaultLanguage).map(language => language.code) });
  if (check.errors.length) throw new Error(check.errors.join('\n'));
  const contents = enumerateContent(repo, config);
  const runDir = prepareBuildDirectory(config);
  const priorManifestFile = path.join(runDir, 'manifests.json');
  const manifests = [];
  let knownManifests = [];
  let sourcePreview = null;
  fs.writeFileSync(priorManifestFile, '[]\n');
  if (languages[0].code !== config.defaultLanguage) {
    const source = config.languages.find(language => language.code === config.defaultLanguage);
    const job = prepareLanguage(config, contents, runDir, 'source-routes', source, true);
    sourcePreview = await runLanguage(job, priorManifestFile);
    knownManifests.push(sourcePreview);
    fs.writeFileSync(priorManifestFile, `${JSON.stringify(knownManifests, null, 2)}\n`);
  }
  for (const [index, language] of languages.entries()) {
    const job = prepareLanguage(config, contents, runDir, index, language);
    const manifest = await runLanguage(job, priorManifestFile);
    if (sourcePreview && language.code === config.defaultLanguage) {
      for (const [id, preview] of Object.entries(sourcePreview.contents)) {
        if (!manifest.contents[id] || manifest.contents[id].url !== preview.url) {
          throw new Error(`Source route changed after route loading: ${id}`);
        }
      }
    }
    manifests.push(manifest);
    knownManifests = [...knownManifests.filter(value => value.language !== manifest.language), manifest];
    fs.writeFileSync(priorManifestFile, `${JSON.stringify(knownManifests, null, 2)}\n`);
  }
  fs.writeFileSync(priorManifestFile, `${JSON.stringify(manifests, null, 2)}\n`);
  const mergedRoot = path.join(runDir, 'merged');
  await mergeBuilds(config, manifests, mergedRoot);
  publishOutput(mergedRoot, config.outputDir);
  return { outputDir: config.outputDir, runDir, manifests };
}

module.exports = { build, runLanguage };
