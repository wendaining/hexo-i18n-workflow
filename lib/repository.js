'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

class Repository {
  constructor({ baseDir = process.cwd(), rev = null } = {}) {
    this.baseDir = path.resolve(baseDir);
    this.rev = rev;
    this.modules = new Map();
    if (rev) this.rev = this.git(['rev-parse', '--verify', `${rev}^{commit}`]).trim();
  }

  relative(file) {
    const absolute = path.resolve(this.baseDir, file);
    const relative = path.relative(this.baseDir, absolute).split(path.sep).join('/');
    if (this.rev && (relative === '..' || relative.startsWith('../'))) {
      throw new Error(`Revision paths must be inside the site: ${file}`);
    }
    return relative;
  }

  git(args, { input, exists = false } = {}) {
    const result = spawnSync('git', args, { cwd: this.baseDir, input, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (exists && result.status === 1) return null;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Git command failed: ${args.join(' ')}`);
    return result.stdout;
  }

  read(file) {
    const relative = this.relative(file);
    return this.rev ? this.git(['show', `${this.rev}:${relative}`]) : fs.readFileSync(path.resolve(this.baseDir, file), 'utf8');
  }

  exists(file) {
    const relative = this.relative(file);
    if (!this.rev) return fs.existsSync(path.resolve(this.baseDir, file));
    const result = spawnSync('git', ['cat-file', '-e', `${this.rev}:${relative}`], { cwd: this.baseDir, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status === 0) return true;
    if (result.status === 128 && /does not exist|exists on disk, but not in|not a valid object name|Not a valid object name/.test(result.stderr)) return false;
    throw new Error(result.stderr.trim() || 'Cannot inspect Git object');
  }

  list(directory) {
    const relative = this.relative(directory);
    if (this.rev) return this.git(['ls-tree', '-rz', '--name-only', this.rev, '--', relative]).split('\0').filter(Boolean);
    const root = path.resolve(this.baseDir, directory);
    if (!fs.existsSync(root)) return [];
    const files = [];
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in content directories: ${full}`);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(this.relative(full));
      }
    };
    walk(root);
    return files.sort();
  }

  blob(file) {
    const relative = this.relative(file);
    if (!this.exists(file)) throw new Error(`Missing file: ${file}`);
    return this.rev ? this.git(['rev-parse', `${this.rev}:${relative}`]).trim() : this.git(['hash-object', '--', relative]).trim();
  }

  readBlob(blob) {
    if (typeof blob !== 'string' || !/^[a-f0-9]{40,64}$/.test(blob)) throw new Error(`Invalid baseline blob: ${blob}`);
    return this.git(['cat-file', 'blob', blob]);
  }

  writeBlob(content, file = null) {
    if (this.rev) throw new Error('Cannot write confirmation data while reading a revision');
    return this.git(['hash-object', '-w', ...(file ? [`--path=${this.relative(file)}`] : []), '--stdin'], { input: content }).trim();
  }

  write(file, content) {
    if (this.rev) throw new Error('Cannot write files while reading a revision');
    const target = path.resolve(this.baseDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  loadModule(file) {
    const relative = this.relative(file);
    if (this.modules.has(relative)) return this.modules.get(relative).exports;
    const filename = path.resolve(this.baseDir, relative);
    const instance = new Module(filename, module);
    this.modules.set(relative, instance);
    instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const dependencyRequire = Module.createRequire(filename);
    instance.require = specifier => {
      if (!specifier.startsWith('.')) return dependencyRequire(specifier);
      const target = path.resolve(path.dirname(filename), specifier);
      const candidate = [target, `${target}.js`, `${target}.json`, path.join(target, 'index.js'), path.join(target, 'index.json')].find(value => {
        if (!this.exists(value)) return false;
        return this.rev ? this.git(['cat-file', '-t', `${this.rev}:${this.relative(value)}`]).trim() === 'blob' : fs.statSync(value).isFile();
      });
      if (!candidate) throw new Error(`Missing extension dependency${this.rev ? ` at ${this.rev}` : ''}: ${specifier}`);
      if (candidate.endsWith('.json')) return JSON.parse(this.read(candidate));
      return this.loadModule(candidate);
    };
    instance._compile(this.read(relative), filename);
    instance.loaded = true;
    return instance.exports;
  }
}

module.exports = { Repository };
