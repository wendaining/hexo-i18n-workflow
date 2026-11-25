# hexo-i18n-workflow

[简体中文](README.zh-CN.md)

A Hexo plugin for multilingual builds, content relationships, and confirmed translation baselines. It supports any configured set of languages, with separate source directories and publication paths.

Requires Node.js 22 or later and Hexo 7.3. The validation environment uses Hexo 7.3.0 and Fluid 1.9.8. Licensed under [GPL-2.0-only](LICENSE).

## Install

Install from GitHub in your Hexo site:

```sh
npm install github:wendaining/hexo-i18n-workflow#v0.1.0
```

Hexo loads the plugin automatically. npm publication is deferred. To pin an installation, append a Git tag or commit to the GitHub dependency URL.

You can also install a local package archive:

```sh
npm install ./hexo-i18n-workflow-0.1.0.tgz
```

The standalone `hexo-i18n` executable supports Git hooks without initializing a theme. Run it through `npx` or an npm script so npm resolves the installed local executable.

## Configure

Put `multilingual` in the site's `_config.yml`. Relative filesystem paths are resolved from the site root. Language codes and publication paths are separate settings.

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

`default_language` identifies the original site. Its code must match one entry in `languages`. Each language needs a code, display name, source directory, and publication path. Paths must start and end with `/`. An optional language configuration file supplies Hexo overrides, such as a different title or permalink rule.

Create each referenced configuration file before running a command. For the example above, `_config.en.yml` can contain:

```yaml
title: English site
description: Notes and articles
```

Source directories must be separate. Build and output directories must be separate from each other and from source directories, theme files, plugin code, Git metadata, and persistent configuration or confirmation files.

### Content relationships

Markdown files are associated by their path relative to each language's source directory:

```text
source/_posts/example.md
i18n/en/_posts/example.md
i18n/ja/_posts/example.md
```

The content ID is `_posts/example.md`. To associate files with different names, put the same `translation_key` in their front matter:

```yaml
translation_key: an-explicit-content-id
```

The content ID and generated URL are stored separately. A custom permalink does not change an explicit content ID.

`lang` describes the actual language of a document. `language` is also accepted. Conflicting values fail validation. An original with a language override remains in its original directory and at its original URL. If its actual language matches a target language, the original supplies that language version without a duplicate page. Translated content must match its target language.

### Translation coverage

| Mode | Behavior |
|---|---|
| `full` | Requires a target version for every public document in scope |
| `partial` | Checks existing versions and offers links only to versions that exist |

Drafts, password protected content, and encrypted content are excluded from translation scope. Hidden articles with public routes remain in scope. Duplicate IDs, orphan translations, language conflicts, and route collisions fail validation.

YAML confirmation checks are enabled by default. `confirmation: false` skips baseline checks and retains content structure and build integrity checks.

## Commands

Run commands from the Hexo site root:

```sh
npx hexo i18n build
npx hexo i18n clean
npx hexo i18n check --rev HEAD
npx hexo i18n check article-name --lang en
npx hexo i18n confirm article-name --lang en
npx hexo i18n confirm --all --lang all
npx hexo i18n migrate
```

The standalone equivalent is `npx hexo-i18n <command>`.

| Option | Behavior |
|---|---|
| `--lang CODE` | Selects a language. Repeat it to select several languages |
| `--rev COMMIT` | Reads configuration, extensions, content, and records from that commit. Available for `check` |
| `--all` | Confirms all selected translations |
| `--translated` | Confirms existing translations |
| `--list` | Prints the checked content IDs and languages |

Checks and builds process all configured target languages by default. When several targets are configured, confirmation requires `--lang CODE` or `--lang all`. Confirmation validates structure before writing records. Checks and builds never confirm content.

`build --lang CODE` builds the original site and selected target languages. Use a full build to publish every configured language. Selecting only the default language builds only the original site.

`clean` deletes the configured output directory and the plugin managed build directory after validating their relationship to protected files. A nonempty build directory must contain this site's ownership marker.

### Build process

Each language runs ordinary Hexo `generate` in a separate child process, with its own database, temporary configuration, and output directory. Generation follows the configured language order. If a target comes before the original site, a separate Hexo loading step obtains the original routes first.

The plugin records actual content and generated routes. It merges successful outputs, then replaces the final output directory. Child failures, `ERROR` or `FATAL` logs, missing files, route collisions, and merge errors abort the build. Failed builds preserve the previous complete output.

Ordinary `hexo generate` also checks content and route conflicts. `hexo i18n build` performs the complete multilingual merge and page processing.

## Confirmation records

The site must be a Git repository when confirmation checks are enabled. Confirmation writes Git blobs, and revision checks and migration read Git objects. Keep the required history available in CI and other checkouts.

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

Each section baseline contains `key`, `level`, and `hash`. Original and translated section baselines are stored independently. Confirming one language preserves the other languages' baselines.

Checks use parsed front matter, Markdown, HTML, and formulas. They compare code fences, inline code, formulas, table shapes, heading levels, lists, blockquotes, and link targets. Text fences permit translated prose while retaining the fence type.

See [MIGRATION.md](MIGRATION.md) for version 1 conversion.

## Public API

```js
const api = require('hexo-i18n-workflow/api');
const repo = new api.Repository({ baseDir: process.cwd() });
const config = api.readConfig({ baseDir: repo.baseDir });
const content = api.enumerateContent(repo, config);
const result = api.checkRepository(repo, config, { lang: 'en' });
const records = api.loadRecords(repo, config);
```

| Interface | Purpose |
|---|---|
| `readConfig({baseDir, rev, hexoConfig})` | Reads and validates shared configuration |
| `enumerateContent(repo, config)` | Returns original content and language relationships |
| `checkRepository(repo, config, options)` | Checks structure and confirmation baselines |
| `confirm(repo, config, options)` | Writes selected confirmation baselines |
| `migrate(repo, config, options)` | Converts version 1 records |
| `loadRecords(repo, config)` | Reads version 2 records |
| `resolvePair(repo, config, input, options)` | Resolves a content ID, path, or article name |
| `listRequiredPairs(repo, config, options)` | Lists translations required by the selected modes |
| `build(config, options)` | Builds and merges language outputs |
| `clean(config)` | Removes validated managed output directories |

Content entries include `id`, `source`, `sourceLanguage`, `kind`, and `versions`. The `markdown` namespace provides parsing and section utilities.

`createContentRoutes(repo, config, content, {manifests})` resolves links with the installed Hexo core's permalink rules without initializing a theme. It reads language overrides from the same revision and prefers supplied real manifests. Themes that change permalink behavior can pass these routes to `validatePair(pair, sourceText, translationText, {repo, config, content, routes})`. `checkRepository` does not accept build manifests. For revision checks, date based permalink rules need a front matter date or dated filename. ID based rules need an explicit `id` or `_id`, or a supplied build manifest.

`createPageIndex(config, manifests)` indexes real build manifests. `languageVersions(index, query)` returns existing versions. A query identifies content with `{contentId, language}` or `{route, language}`. The query's `language` selects a site language. Each version includes its actual content language, URL, original flag, and current flag.

`commentIdentity(index, query, options)` returns `contentId`, `currentLanguage`, `sourceUrl`, `currentUrl`, and `discussionId`. Shared mode uses the content ID. Independent mode appends the actual language. API options or a site extension can provide a custom `discussionId(identity)` function. Querying comments without an original route fails.

`translationNotice(index, query)` returns notice data. `renderTranslationNotice(notice, {format: 'html'|'markdown'})` uses the same data for both formats. `{original}` is replaced by a link to the original version.

## Themes, pages, and resources

Hexo helpers are `i18n_versions(page)`, `i18n_language_menu(page)`, `i18n_comments(page)`, `i18n_notice(page, format)`, and `i18n_sitemap_url()`.

The Fluid adapter inserts a language dropdown into the rendered navigation. It retains the theme's navigation template, search, and color controls. The menu supports pointer and keyboard input. Other themes can place `i18n_language_menu(page)` in their own template.

Final page processing uses actual rendered heading IDs for chapter links. A valid mapping preserves the chapter position when switching languages. Otherwise the link opens the corresponding page. Internal links use content relationships and available versions. Missing target versions retain a valid original URL.

Each version has its own canonical URL. `hreflang` contains existing versions, and `x-default` points to the original. Existing language sitemaps are merged as XML.

Resource sharing is limited to `shared_assets`. Identical files are shared after comparing hashes. CSS sharing also compares referenced resources and recursive imports. Different contents at the same relative path retain their language copies. A resource present only in the original site can serve another language through its original URL. HTML, XML, and CSS references are updated to the retained resource.

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
    // Write site publication files to the merged output.
  }
};
```

Data paths are resolved within each language's source directory. A validation context contains the repository, configuration, content entry, and target language. Merge extensions run after core resource and page processing.

Translation providers, terminology, comments, custom generators, and hosting rules remain site concerns. They can use configuration, helpers, and extensions to integrate with the plugin.

## Development

```sh
git clone https://github.com/wendaining/hexo-i18n-workflow.git
cd hexo-i18n-workflow
npm ci
npm test
npm pack
```

Tests use real Hexo sites, files, and temporary Git repositories. They cover three languages, isolated databases, custom directories and permalinks, confirmation records, migration, failed builds, resources, and installation of a packed archive in a separate Hexo site. Development dependencies are declared in this repository.

## License

[GNU General Public License version 2 only](LICENSE), SPDX identifier `GPL-2.0-only`.
