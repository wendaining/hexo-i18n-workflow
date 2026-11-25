# hexo-i18n-workflow

Local Hexo plugin for multilingual builds, content relationships and confirmed translation baselines. Requires Node.js 22 or later and Hexo 7.3. The package is private. Its license and public package name will be decided when it moves to a separate repository.

## Install

Add the package to a Hexo site's dependencies and run `npm install`:

```json
{
  "dependencies": {
    "hexo": "7.3.0",
    "hexo-i18n-workflow": "file:plugins/hexo-i18n-workflow"
  }
}
```

Hexo loads the plugin automatically. The standalone `hexo-i18n` executable supports Git hooks without loading the theme.

## Configure

Put `multilingual` in the site's `_config.yml`. Relative filesystem paths are resolved from the site root. Language codes and publication paths are separate values.

```yaml
url: https://example.com/
source_dir: source
public_dir: public
multilingual:
  default_language: zh-CN
  records: i18n/confirmations.yml
  build_dir: .hexo-i18n
  output_dir: public
  confirmation: true
  shared_assets: [img, css, js, lib]
  comments:
    mode: shared
  languages:
    - code: zh-CN
      name: 简体中文
      source_dir: source
      path: /
    - code: en
      name: English
      source_dir: i18n/en
      path: /english/
      config: _config.en.yml
      mode: full
      notice:
        text: 'This is a translation. Read {original} for the original text.'
        link_text: the original
    - code: ja
      name: 日本語
      source_dir: i18n/ja
      path: /ja/
      mode: partial
```

The default language identifies the source site. `lang` overrides a document's actual language and takes precedence over `language`. Conflicting fields fail validation. A source document remains at its source location and URL. If its actual language equals a target language, that original supplies the language version without a duplicate page.

Markdown files are associated by their path relative to each language's source directory. A shared front matter `translation_key` associates files with different names. The relative path or explicit key is the content ID. Hexo's generated route is stored separately. A custom permalink does not change an explicit ID.

`full` requires a target version for every public document in scope. `partial` checks existing versions. Drafts, password protected content and encrypted content are excluded from translation scope. Duplicate IDs, orphan translations, language conflicts and route collisions fail validation. Disabling `confirmation` skips YAML baseline checks and retains content validation and build integrity checks.

## Commands

```sh
hexo i18n build
hexo i18n clean
hexo i18n check --rev HEAD
hexo i18n check article-name --lang en
hexo i18n confirm article-name --lang en
hexo i18n confirm --all --lang all
hexo i18n migrate
```

The standalone equivalent is `hexo-i18n <command>`. `--lang CODE` may be repeated. Checks and builds process all configured languages by default. Confirmation requires a selected target language or `--lang all` when several targets exist. `confirm --translated` selects existing translations. `check --rev COMMIT` reads configuration, extension modules, content and records from that commit. Confirmation and migration write the current working tree.

A build runs ordinary Hexo `generate` in sequential child processes. Each child has its own database, configuration and output directory. The plugin records actual Hexo document routes and all generated routes. It merges successful language outputs, then replaces the final output. Child errors, error logs, missing files, route collisions and merge errors abort the build. A failed build preserves the previous complete output.

`build --lang CODE` builds the original site and the selected target languages. It keeps original URLs available for comments, notices and language links. Use a full build to publish every configured language. `clean` deletes the configured output directory and plugin managed build directory after checking source overlaps and symbolic links. It rejects a nonempty build directory without this site's ownership marker.

Ordinary `hexo generate` also checks content and generated route conflicts. `hexo i18n build` performs the complete multilingual merge and page enrichment.

## Confirmation records

Version 2 records use this shape:

```yaml
version: 2
contents:
  _posts/example.md:
    kind: post
    source: source/_posts/example.md
    source_language: zh-CN
    translations:
      en:
        translation: i18n/en/_posts/example.md
        source_hash: ...
        translation_hash: ...
        source_blob: ...
        translation_blob: ...
        source_meta_hash: ...
        translation_meta_hash: ...
        source_sections: []
        translation_sections: []
```

Each section baseline contains `key`, `level` and `hash`. Source and translated section baselines are stored independently. Confirming one language preserves the other languages' baselines. Checks and builds never confirm content. Code fences, inline code, formulas, tables, heading levels, list structure, blockquotes and link targets are checked from parser results. Text fences permit translated prose while retaining fence types.

See [MIGRATION.md](MIGRATION.md) for version 1 conversion.

## Public API and themes

```js
const api = require('hexo-i18n-workflow/api');
const repo = new api.Repository({ baseDir: process.cwd() });
const config = api.readConfig({ baseDir: repo.baseDir });
const content = api.enumerateContent(repo, config);
const result = api.checkRepository(repo, config, { lang: 'en' });
const records = api.loadRecords(repo, config);
```

The API also exposes `confirm(repo, config, options)`, `migrate(repo, config, options)`, `build(config, options)`, `clean(config)`, `resolvePair(repo, config, input, options)` and `listRequiredPairs(repo, config, options)`. Content entries contain `id`, `source`, `sourceLanguage`, `kind` and `versions`. The `markdown` namespace provides parser and section utilities.

`createPageIndex(config, manifests)` uses real build manifests. `languageVersions(index, query)` returns existing versions. A query identifies a document by `{contentId, language}` or `{route, language}`. The `language` query field selects the site language. Each result includes the actual content language, URL, source flag and current flag.

`commentIdentity(index, query, options)` returns `contentId`, `currentLanguage`, `sourceUrl`, `currentUrl` and `discussionId`. Shared mode uses the content ID. Independent mode appends the actual language. A custom `discussionId(identity)` function can be supplied in API options or a site extension.

`translationNotice(index, query)` returns notice data. `renderTranslationNotice(notice, {format: 'html'|'markdown'})` uses the same data for both formats.

Hexo helpers are `i18n_versions(page)`, `i18n_language_menu(page)`, `i18n_comments(page)`, `i18n_notice(page, format)` and `i18n_sitemap_url()`. Other themes can render the menu through their own template. The Fluid adapter inserts one menu item into the rendered navigation and retains the original navigation template. Its assets support pointer and keyboard operation. Final page enrichment uses actual rendered heading IDs, canonical URLs and existing versions for language links and `hreflang`. `x-default` points to the original version.

Shared resources are limited to `shared_assets`. Identical files are shared after comparing their hashes. Different contents at the same relative asset path retain their language copies. HTML and XML references are updated to the retained asset. Sitemaps are merged as parsed XML.

## Site extensions

Set `multilingual.extensions` to site relative CommonJS module paths. An extension can expose:

```js
module.exports = {
  content: [{
    id: '_data/links.yml',
    relative: '_data/links.yml',
    kind: 'data',
    route: 'links/',
    validate(sourceText, translationText, context) {
      // Return an array of validation errors or undefined.
    }
  }],
  discussionId(identity) {
    return identity.contentId;
  },
  merge({ config, manifests, outputDir }) {
    // Write site specific publication files to the merged output.
  }
};
```

Data paths are resolved within each language's source directory. Merge extensions run after core asset and page processing. The plugin does not require Fluid, Giscus, a model provider, Cloudflare or any private blog module.

## Validate and extract

The package tests use real Hexo sites, files and Git repositories. They cover three languages, independent databases, custom paths and permalinks, records, failed builds, resources and installation from a packed tarball outside this repository.

```sh
npm test --prefix plugins/hexo-i18n-workflow
npm pack ./plugins/hexo-i18n-workflow
```

To extract the package, move this directory into its own repository, preserve its tests and direct dependencies, decide its license and name, update package metadata and change the site's dependency to the selected package source.
