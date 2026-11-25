# hexo-i18n-workflow

[English](README.md)

用于多语言构建、内容关联和翻译确认记录的 Hexo 插件。语言数量、源目录和发布路径均可配置。

需要 Node.js 22 或更新版本，以及 Hexo 7.3。验证环境使用 Hexo 7.3.0 和 Fluid 1.9.8。许可证为 [GPL-2.0-only](LICENSE)。

## 安装

在 Hexo 站点中从 GitHub 安装：

```sh
npm install github:wendaining/hexo-i18n-workflow#v0.1.0
```

Hexo 会自动加载插件。npm 发布暂缓。GitHub 依赖地址可指定标签或提交，固定安装版本。

也可以安装本地包文件：

```sh
npm install ./hexo-i18n-workflow-0.1.0.tgz
```

独立的 `hexo-i18n` 命令可用于 Git hook，检查时无需初始化主题。通过 `npx` 或 npm script 调用站点安装的命令。

## 配置

在站点 `_config.yml` 中添加 `multilingual`。相对文件路径以站点根目录解析，语言代码和发布路径分别配置。

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

`default_language` 指定原文站点，必须对应 `languages` 中的一项。每种语言配置代码、显示名称、源目录和发布路径。发布路径以 `/` 开始并以 `/` 结束。可选配置文件提供该语言的 Hexo 覆盖设置，例如标题和永久链接规则。

执行命令前创建配置中引用的文件。上面的 `_config.en.yml` 可写为：

```yaml
title: English site
description: Notes and articles
```

各语言源目录必须分开。构建目录和输出目录必须互相分开，并避开源目录、主题文件、插件代码、Git 数据、配置和确认记录。

### 内容关联

默认按各语言源目录内的相对路径关联 Markdown 文件：

```text
source/_posts/example.md
i18n/en/_posts/example.md
i18n/ja/_posts/example.md
```

内容标识为 `_posts/example.md`。文件名不同时，在各版本 front matter 中使用共同的 `translation_key`：

```yaml
translation_key: an-explicit-content-id
```

内容标识与生成 URL 分开保存。修改永久链接不会改变显式内容标识。

`lang` 描述文档的实际语言，也兼容 `language`。两个字段冲突时检查失败。原文设置语言覆盖后，仍在原目录和原地址发布。原文实际语言等于目标语言时，直接提供原文作为该语言版本。译文的实际语言必须符合其目标语言。

### 翻译覆盖

| 模式 | 行为 |
|---|---|
| `full` | 范围内每篇公开内容都必须有目标版本 |
| `partial` | 检查已有版本，仅提供实际存在的版本链接 |

草稿、设置密码的内容和加密内容不进入翻译范围。拥有公开地址的隐藏文章仍在范围内。重复标识、孤立译文、语言冲突和路由冲突均导致检查失败。

YAML 确认检查默认开启。设置 `confirmation: false` 后跳过基准检查，仍检查内容结构和构建完整性。

## 命令

从 Hexo 站点根目录执行：

```sh
npx hexo i18n build
npx hexo i18n clean
npx hexo i18n check --rev HEAD
npx hexo i18n check article-name --lang en
npx hexo i18n confirm article-name --lang en
npx hexo i18n confirm --all --lang all
npx hexo i18n migrate
```

独立命令写法为 `npx hexo-i18n <command>`。

| 参数 | 行为 |
|---|---|
| `--lang CODE` | 选择语言，可重复指定多种语言 |
| `--rev COMMIT` | 从提交读取配置、扩展、内容和记录，仅用于 `check` |
| `--all` | 确认所选语言的全部译文 |
| `--translated` | 确认已有译文 |
| `--list` | 列出检查的内容标识和语言 |

检查和构建默认处理全部目标语言。存在多种目标语言时，确认必须指定 `--lang CODE` 或 `--lang all`。确认命令先检查结构，再写入记录。检查和构建均不自动确认内容。

`build --lang CODE` 构建原文站和所选目标语言。发布全部配置语言时执行完整构建。仅选择默认语言时，只构建原文站。

`clean` 检查目录与受保护文件的关系，再删除配置的输出目录和插件管理的构建目录。非空构建目录必须有当前站点的管理标记。

### 构建过程

每种语言在独立子进程中执行普通 Hexo `generate`，各自使用数据库、临时配置和输出目录。生成顺序遵循语言配置。如果目标语言排在原文站之前，会先用独立 Hexo 加载步骤取得原文路由。

插件记录真实内容路由和生成路由。各语言成功后合并产物，再替换最终输出目录。子进程失败、ERROR 或 FATAL 日志、缺失文件、路由冲突和合并错误均终止构建。失败构建保留上一份完整输出。

普通 `hexo generate` 同样检查内容和路由冲突。`hexo i18n build` 执行完整的多语言合并和页面处理。

## 确认记录

开启确认检查时，站点必须是 Git 仓库，并安装 Git 命令。确认写入 Git blob，指定提交检查和迁移读取 Git 对象。CI 和其他检出需要保留所需历史。

版本 2 记录格式：

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

每个章节基准包含 `key`、`level` 和 `hash`。原文与译文章节基准独立保存。确认一种语言时保留其他语言的基准。

检查基于 front matter、Markdown、HTML 和公式的解析结果，比较代码围栏、行内代码、公式、表格结构、标题层级、列表、引用和链接目标。文本围栏允许翻译正文，保留围栏类型。

版本 1 转换说明见 [MIGRATION.md](MIGRATION.md)。

## 公开 API

```js
const api = require('hexo-i18n-workflow/api');
const repo = new api.Repository({ baseDir: process.cwd() });
const config = api.readConfig({ baseDir: repo.baseDir });
const content = api.enumerateContent(repo, config);
const result = api.checkRepository(repo, config, { lang: 'en' });
const records = api.loadRecords(repo, config);
```

| 接口 | 用途 |
|---|---|
| `readConfig({baseDir, rev, hexoConfig})` | 读取并检查统一配置 |
| `enumerateContent(repo, config)` | 返回原文与语言关系 |
| `checkRepository(repo, config, options)` | 检查结构和确认基准 |
| `confirm(repo, config, options)` | 写入所选确认基准 |
| `migrate(repo, config, options)` | 转换版本 1 记录 |
| `loadRecords(repo, config)` | 读取版本 2 记录 |
| `resolvePair(repo, config, input, options)` | 从内容标识、路径或文章名称查找内容 |
| `listRequiredPairs(repo, config, options)` | 列出所选模式要求的译文 |
| `build(config, options)` | 构建并合并语言输出 |
| `clean(config)` | 删除已检查的管理目录 |

内容项包含 `id`、`source`、`sourceLanguage`、`kind` 和 `versions`。`markdown` 提供解析和章节工具。

`createContentRoutes(repo, config, content, {manifests})` 使用已安装 Hexo 核心的永久链接规则解析链接，无需初始化主题。它从相同提交读取语言覆盖配置，并优先使用提供的真实清单。主题修改永久链接行为时，可将所得 `routes` 传给 `validatePair(pair, sourceText, translationText, {repo, config, content, routes})`。`checkRepository` 当前不接受构建清单。指定提交中的日期型永久链接需要 front matter 日期或带日期的文件名。ID 型规则需要显式 `id`、`_id` 或构建清单。

`createPageIndex(config, manifests)` 索引真实构建清单。`languageVersions(index, query)` 返回已有版本。查询使用 `{contentId, language}` 或 `{route, language}`，其中 `language` 选择站点语言。返回版本包含实际内容语言、URL、原文标记和当前标记。

`commentIdentity(index, query, options)` 返回 `contentId`、`currentLanguage`、`sourceUrl`、`currentUrl` 和 `discussionId`。共享模式使用内容标识，独立模式加入实际语言。API 参数或站点扩展可提供自定义 `discussionId(identity)` 函数。缺少原文路由时，评论查询失败。

`translationNotice(index, query)` 返回翻译提示数据。`renderTranslationNotice(notice, {format: 'html'|'markdown'})` 将同一份数据输出为 HTML 或 Markdown，`{original}` 替换为原文链接。

## 主题、页面和资源

Hexo helper 包括 `i18n_versions(page)`、`i18n_language_menu(page)`、`i18n_comments(page)`、`i18n_notice(page, format)` 和 `i18n_sitemap_url()`。

Fluid 适配器在渲染后的导航中插入语言下拉菜单，保留主题导航模板、搜索和颜色按钮。菜单支持鼠标与键盘操作。其他主题可在模板中使用 `i18n_language_menu(page)`。

页面处理使用真实标题 ID 建立章节链接。存在有效映射时，切换语言保留章节位置，否则打开对应页面。站内链接使用内容关系和已有版本，缺少目标版本时保留有效原文 URL。

各版本拥有自己的 canonical。`hreflang` 只包含已有版本，`x-default` 指向原文。各语言已有 sitemap 按 XML 合并。

资源共享限于 `shared_assets`。确认哈希相同后共享文件，CSS 还比较引用资源及递归导入。相同路径但内容不同的资源保留各语言副本。仅存在于原文站的资源可通过原地址供其他语言使用。HTML、XML 和 CSS 引用会更新为保留的资源地址。

## 站点扩展

`multilingual.extensions` 配置站点根目录内的 CommonJS 模块路径。扩展可导出：

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

数据路径以各语言源目录解析。检查上下文包含仓库、配置、内容项和目标语言。合并扩展在核心资源和页面处理后执行。

翻译服务、术语表、评论、自定义生成器和发布规则由站点维护，通过配置、helper 和扩展接入插件。

## 开发

```sh
git clone https://github.com/wendaining/hexo-i18n-workflow.git
cd hexo-i18n-workflow
npm ci
npm test
npm pack
```

测试使用真实 Hexo 站点、文件系统和临时 Git 仓库，覆盖三种语言、独立数据库、自定义目录和永久链接、确认记录、迁移、构建失败、资源，以及独立站点安装打包文件。仓库已声明开发依赖。

## 许可证

[GNU General Public License version 2 only](LICENSE)，SPDX 标识为 `GPL-2.0-only`。
