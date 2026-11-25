# Migrate confirmation baselines

The explicit `hexo-i18n migrate` command converts version 1 bilingual records into version 2 multilingual records. Configure the source and target languages, source directories and records path before running it.

```sh
hexo-i18n migrate
hexo-i18n check
```

The command associates each recorded source path with its content ID and each translation path with exactly one configured target language. It preserves the recorded content hashes, metadata hashes and Git blob IDs. It reads the recorded blobs to compute independent source and translated section baselines. It does not take the current files as confirmed content.

Migration fails if a required blob is absent, its recorded hash is inconsistent, a content relationship is ambiguous or the input is not a version 1 mapping. It prepares all records before writing the YAML file. Unconfirmed working tree changes remain detectable after conversion.

Keep Git history available when migrating. If a baseline blob is missing locally, fetch the relevant history before retrying. A clean checkout's recorded blobs must exist in reachable commit history.

After conversion, records live at `contents[id].translations[language]`. Translation tools should obtain relationships and records through `hexo-i18n-workflow/api`. The daily workflow remains reading the original and current translation, editing the translation, checking its structure, explicitly confirming it and building the site.
