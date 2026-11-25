'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { checkManagedDirectories } = require('./config');

const MARKER = '.hexo-i18n-workflow';

function prepareBuildDirectory(config) {
  checkManagedDirectories(config);
  fs.mkdirSync(config.buildDir, { recursive: true });
  const marker = path.join(config.buildDir, MARKER);
  const identity = `${fs.realpathSync(config.baseDir)}\n`;
  if (!fs.existsSync(marker) && fs.readdirSync(config.buildDir).length) {
    throw new Error(`Build directory contains unmanaged files: ${config.buildDir}`);
  }
  if (fs.existsSync(marker) && (!fs.lstatSync(marker).isFile() || fs.readFileSync(marker, 'utf8') !== identity)) {
    throw new Error(`Build directory is not managed by this site: ${config.buildDir}`);
  }
  fs.writeFileSync(marker, identity);
  return fs.mkdtempSync(path.join(config.buildDir, 'run-'));
}

function clean(config) {
  checkManagedDirectories(config);
  if (fs.existsSync(config.buildDir)) {
    const marker = path.join(config.buildDir, MARKER);
    if (fs.readdirSync(config.buildDir).length && (!fs.existsSync(marker) || !fs.lstatSync(marker).isFile()
      || fs.readFileSync(marker, 'utf8') !== `${fs.realpathSync(config.baseDir)}\n`)) {
      throw new Error(`Build directory is not managed by this site: ${config.buildDir}`);
    }
    fs.rmSync(config.buildDir, { recursive: true, force: true });
  }
  fs.rmSync(config.outputDir, { recursive: true, force: true });
}

module.exports = { MARKER, prepareBuildDirectory, clean };
