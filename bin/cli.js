#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');

function argumentsFor(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      lang: { type: 'string', multiple: true },
      rev: { type: 'string' },
      all: { type: 'boolean' },
      translated: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  return { ...values, command: positionals[0], inputs: positionals.slice(1) };
}

async function main(argv = process.argv.slice(2), { baseDir = process.cwd() } = {}) {
  const args = argumentsFor(argv);
  if (args.help || !args.command) {
    console.log('Usage: hexo-i18n <build|clean|check|confirm|migrate> [content...] [options]');
    console.log('  --lang CODE     Select a language. Repeat to select several languages.');
    console.log('  --rev COMMIT    Check configuration, content and records from a commit.');
    console.log('  --all           Confirm all selected translations.');
    console.log('  --translated    Confirm existing translations.');
    console.log('  --list          Print the checked content.');
    return;
  }
  const api = require('../api');
  if (args.rev && args.command !== 'check') throw new Error('--rev is only supported by check');
  const repo = new api.Repository({ baseDir, rev: args.rev });
  const config = api.readConfig({ baseDir, rev: args.rev });
  const ids = args.inputs.length
    ? args.inputs.map(input => {
      const pair = api.resolvePair(repo, config, input, { lang: args.lang });
      if (!pair) throw new Error(`Unknown content: ${input}`);
      return pair.id;
    })
    : undefined;
  const options = { lang: args.lang, ids, all: args.all, translated: args.translated };
  if (args.command === 'build') return api.build(config, options);
  if (args.command === 'clean') return api.clean(config);
  if (args.command === 'migrate') {
    const records = api.migrate(repo, config, options);
    console.log(`Migrated ${Object.keys(records.contents).length} content records.`);
    return;
  }
  if (args.command === 'confirm') {
    for (const result of api.confirm(repo, config, options)) {
      console.log(`Confirmed ${result.id} (${result.language})`);
    }
    return;
  }
  if (args.command === 'check') {
    const result = api.checkRepository(repo, config, options);
    if (args.list) {
      for (const entry of result.required) console.log(`${entry.id}\t${entry.language}`);
    }
    if (result.errors.length) throw new Error(result.errors.join('\n'));
    console.log(`Multilingual check passed for ${result.required.length} translations.`);
    return;
  }
  throw new Error(`Unknown i18n command: ${args.command}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { argumentsFor, main };
