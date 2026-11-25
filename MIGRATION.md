# Migrate confirmation baselines

The explicit `hexo-i18n migrate` command converts version 1 bilingual records into version 2 multilingual records. Configure the original and target languages, source directories, and records path before running it.

Run from the Hexo site root:

```sh
npx hexo-i18n migrate
npx hexo-i18n check
```

The command associates each recorded original path with its content ID and each translation path with exactly one configured target language. It preserves recorded content hashes, metadata hashes, and Git blob IDs. It reads the recorded blobs to calculate independent original and translated section baselines. Current working tree content is not automatically confirmed.

Migration fails if a required blob is absent, a recorded hash is inconsistent, a content relationship is ambiguous, or the input is not a version 1 mapping. It prepares all records before writing the YAML file. Unconfirmed changes remain detectable after conversion.

Keep the required Git history available. If a baseline blob is absent locally, fetch the relevant history before retrying. Recorded baseline blobs must remain available through repository history in other checkouts and CI.

## Version 2 structure

Records live at `contents[id].translations[language]`. The content ID is the original path relative to its source directory, or the shared front matter `translation_key`.

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

`source_sections` and `translation_sections` contain independent `{key, level, hash}` baselines. Confirming one target language updates only its baseline.

## Translation tools

Use the public API to resolve relationships and read records:

```js
const api = require('hexo-i18n-workflow/api');
const repo = new api.Repository({ baseDir: process.cwd() });
const config = api.readConfig({ baseDir: repo.baseDir });
const pair = api.resolvePair(repo, config, 'example', { lang: 'en' });
const baseline = api.loadRecords(repo, config).contents[pair.id].translations.en;
const original = repo.readBlob(baseline.source_blob);
```

The daily workflow is to read the original and current translation, edit the translation, explicitly confirm it, check it, and build the site:

```sh
npx hexo-i18n confirm example --lang en
npx hexo-i18n check example --lang en
npx hexo i18n build
```

Confirmation checks structure before writing records. With several target languages, specify `--lang CODE` or `--lang all`. Checks and ordinary builds never confirm content.
