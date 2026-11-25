/* global hexo */
'use strict';

function install(instance) {
  instance.extend.console.register('i18n', 'Build and check multilingual content', {
    usage: '<build|clean|check|confirm|migrate> [content...] [--lang CODE]'
  }, args => {
    const argv = [...(args._ || [])];
    for (const flag of ['all', 'translated', 'list', 'help']) {
      if (args[flag]) argv.push(`--${flag}`);
    }
    for (const flag of ['lang', 'rev']) {
      for (const value of [].concat(args[flag] || [])) argv.push(`--${flag}`, value);
    }
    return require('./bin/cli').main(argv, { baseDir: instance.base_dir });
  });
  require('./lib/site').install(instance);
}

if (typeof hexo !== 'undefined') install(hexo);

module.exports = { install };
