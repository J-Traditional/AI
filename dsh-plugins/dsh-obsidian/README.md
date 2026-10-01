# dsh-obsidian

把本机已安装的 Obsidian 库接入 DeepSeek Harness（DSH）工作区：自动发现库、把笔记元数据索引到工作区、按需读全文与检索，并且只在该库被显式允许的写入范围内写回。

正文**不会**被复制进工作区，所以索引永远不会变成一个走味的第二份库。

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| 自动发现 | 读 Obsidian 自己的库注册表（`%APPDATA%\obsidian\obsidian.json`，并覆盖 macOS / Linux 位置），默认选中当前打开的那个库；显式配置优先 |
| 元数据索引 | 解析 frontmatter、标签（含行内 `#标签`）、wikilink、标题与首段摘要，写入 `INDEX.md` 与 `index.json` |
| 反向链接 | 用「路径」与「裸文件名」两种写法解析 `[[...]]`，把未解析的链接单独记在 `unresolved` 里 |
| 全文检索 | 每次调用都读磁盘正文，结果不会过期；多词为「全部命中」语义，标题/标签/topic 命中加权 |
| 变更检测 | 用「笔记数 + 最新 mtime + 总字节」作为签名，签名变了才重建索引 |
| 写入边界 | 只允许写配置里的白名单前缀；**未配置时写入整体禁用**，越界直接拒绝并说明原因 |

## 已注册的工具

| 工具 | 用途 |
| --- | --- |
| `obsidian_status` | 连接状态、发现的全部库、索引新鲜度 |
| `obsidian_list` | 列笔记元数据，支持 folder / domain / status / tag 过滤与分页 |
| `obsidian_read` | 读一篇笔记，带 frontmatter、标签、出链、反向链接，按行翻页 |
| `obsidian_search` | 全文检索，带行号与上下文片段 |
| `obsidian_sync` | 重新扫描并刷新工作区索引 |
| `obsidian_write` | 创建 / 追加 / 覆盖笔记，仅限白名单前缀内 |

## 配置

全部字段可选：

```yaml
- id: obsidian
  name: dsh-obsidian
  config:
    vault: '/path/to/vault'              # 省略则用 Obsidian 当前打开的库
    indexDir: '/path/to/workspace/obsidian'  # 省略则索引只在内存里，不落盘
    ignoreDirs: []                       # 额外跳过的目录名（.obsidian/.git/node_modules 等默认已跳过）
    writeAllow: ['notes/inbox']          # 允许 Agent 写入的库内相对前缀；默认 []，即写入禁用
    autoSync: true                       # 挂载时构建并落盘索引
```

两个刻意的默认值：`writeAllow` 为空（没配好就不动库），`indexDir` 为空（不配置就不往磁盘写）。

`vault` 与 `indexDir` 这类「因部署而异」的值刻意不写进包内补丁——包自带的 `cordis.patch.yml` 只挂载插件，具体路径由使用者的配置档给出。

## 两种挂载方式

**一、配置档补丁直接挂载绝对路径（热加载，无需重启）**

```yaml
- insert:
    - id: obsidian
      name: '/path/to/dsh-obsidian/index.js'
      config:
        vault: '/path/to/vault'
        indexDir: '/path/to/workspace/obsidian'
        writeAllow: ['notes/inbox']
```

补丁文件属于热加载层，改完即生效。

**但补丁热加载只重放配置，不重载已导入的模块。** 改了 `index.js` / `vault.js` 的代码后，运行中的进程里仍是旧模块。base 的 `hmr` 行默认 `root: []`（只监听配置/补丁），要监听源码模块必须显式打开：

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root:
      - '/path/to/dsh-obsidian'
    ignored:
      - '**/node_modules'
      - '**/.git'
      - 'cache'
      - 'data'
```

两个坑，都踩过：

1. `base` 是当作 URL 解析的（`new URL(config.base, ctx.baseUrl)`），给它一个 Windows 绝对路径会报错。用**绝对 `root`** 配默认 `base` 即可——`root` 走 `resolve(watchBaseDir, path)`，绝对路径会正确重置。
2. 默认 `ignored` 里的 `**/.*` 会匹配 `relative()` 出来的 `../..` 前缀，把 base 之外的插件文件**全部静默过滤掉**，必须去掉它，否则 watcher 装上了也什么都不监听。

监听范围应只覆盖插件目录；插件自己写出的 `INDEX.md` 不在其中，因此不会触发重载回环。（`awaitWriteFinish` 默认开启，编辑后约 2 秒才触发。）

**二、作为 bundle 正式安装（需重启配置档）**

```sh
dsh plugin --profile <name> add <插件目录>
```

包内 `package.json` 声明了 `dsh.bundle.patch`，bundle 层会用**同一个 id `obsidian`** 挂载同一个插件。若已经用方式一挂载，请删掉方式一的那段补丁，避免两处并存。

## 自检

```sh
node selftest.mjs
```

自检断言覆盖：库发现、frontmatter/YAML 子集解析、标签与 wikilink 提取（含代码围栏、`#` 标题误判、表格内转义竖线）、全库索引统计、反向链接解析（路径与裸文件名两种写法）、读取翻页、路径穿越防护、全文检索与各类过滤、片段截断、写入边界与默认禁用、写入行为，以及「用假 ctx 真正装配插件并逐个调用六个工具」。

自检**自带 fixture**：脚本在临时目录里自建一个库（含嵌套目录、无 frontmatter 的笔记、零字节笔记、围栏内的 `#` 行、超长行、两种写法的 wikilink、无法解析的链接），跑完删除，因此不读也不写任何真实库，也不依赖任何具体部署。每个工具调用都会额外校验返回值是 lossless JSON —— `undefined` 一旦泄漏进 canonical value，DSH 会整体拒绝该次调用，这是实际踩过的坑。

## 设计约束

- **零依赖**，只用 Node 内置模块。插件通常以绝对路径从配置档补丁加载（out-of-tree），这个位置导入 `@deepseek-ai/*` 的解析并不可靠，因此工具定义是原始 JSON Schema，参数校验在 `execute` 内自行完成。
- frontmatter 用的是**容错的 YAML 子集**（标量、内联数组、块数组、引号、布尔、数字），更复杂的结构宁可留作原文也不猜。
- 检索不做缓存：直接读磁盘更快，也更不容易给出过期结果。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件入口：读取配置、连接库、注册六个工具、渲染模型读到的文本 |
| `vault.js` | 库核心：发现、解析、索引、检索、读、写，纯函数 |
| `selftest.mjs` | 自检（自带 fixture，可移植） |
| `cordis.patch.yml` | bundle 层补丁（只挂载，不带任何机器相关配置） |
