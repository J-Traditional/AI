/**
 * dsh-obsidian — connect an installed Obsidian vault to the Harness workspace.
 *
 * The vault is Obsidian's to own: this plugin reads it, indexes its metadata
 * into the session workspace, and writes back only inside the directories the
 * vault's own conventions reserve for AI output. Note bodies are never copied
 * into the workspace, so the index cannot drift into a stale second vault.
 *
 * Loaded out-of-tree (an absolute path in the profile patch), so tool
 * definitions are raw JSON Schema and there is no `@deepseek-ai/*` import:
 * exactly the position modsearch documents as unreliable for resolution.
 *
 * Config (all optional; the profile patch supplies the concrete values):
 *   vault       — vault path. Omitted: the vault Obsidian has open.
 *   indexDir    — directory for the generated INDEX.md + index.json.
 *                 Omitted: index in memory only, no files written.
 *   ignoreDirs  — extra directory names to skip while walking.
 *   writeAllow  — vault-relative prefixes the agent may write.
 *                 Default: [] — agent writes stay disabled until configured,
 *                 so an unconfigured deployment cannot touch a vault.
 *   autoSync    — build and write the index when the plugin loads.
 *                 Default: true.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildIndexFromFiles,
  discoverVaults,
  formatBytes,
  normalizeRel,
  readNote,
  renderIndexMarkdown,
  resolveVault,
  sameSignature,
  scanVault,
  searchVault,
  signatureOf,
  writeNote,
} from './vault.js'

export const name = 'obsidian'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: value }]
const asInt = (value, fallback) => (Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback)

function normalizeConfig(config) {
  const strings = (value) => (Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [])
  return {
    vault: typeof config.vault === 'string' && config.vault.trim() ? config.vault.trim() : null,
    indexDir: typeof config.indexDir === 'string' && config.indexDir.trim() ? config.indexDir.trim() : null,
    ignoreDirs: strings(config.ignoreDirs),
    writeAllow: strings(config.writeAllow),
    autoSync: config.autoSync !== false,
  }
}

/** Frontmatter the model supplies as an object, rendered as the YAML block. */
function renderFrontmatter(data) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) lines.push(`${key}: [${value.map((item) => String(item)).join(', ')}]`)
    else lines.push(`${key}: ${String(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const state = { options, vault: null, index: null, files: null, error: null }

  /** Rebuild only when the vault's signature moved; `force` for an explicit sync. */
  const ensure = (force = false) => {
    if (!state.vault) state.vault = resolveVault(options.vault)
    const files = scanVault(state.vault.path, { ignoreDirs: options.ignoreDirs })
    const signature = signatureOf(files)
    if (!force && state.index && sameSignature(state.index.signature, signature)) return state.index
    state.index = buildIndexFromFiles(state.vault.path, files, { ignoreDirs: options.ignoreDirs })
    return state.index
  }

  const syncToDisk = () => {
    if (!options.indexDir) return null
    mkdirSync(options.indexDir, { recursive: true })
    const json = join(options.indexDir, 'index.json')
    const markdown = join(options.indexDir, 'INDEX.md')
    writeFileSync(json, `${JSON.stringify(state.index, null, 2)}\n`, 'utf8')
    writeFileSync(markdown, renderIndexMarkdown(state.index), 'utf8')
    state.files = { dir: options.indexDir, json, markdown }
    return state.files
  }

  const status = () => {
    const index = state.index
    let stale = null
    if (index && state.vault) {
      try {
        stale = !sameSignature(index.signature, signatureOf(scanVault(state.vault.path, { ignoreDirs: options.ignoreDirs })))
      } catch {
        stale = null
      }
    }
    return {
      connected: !!state.vault && !state.error,
      vaultPath: state.vault?.path ?? null,
      vaultSource: state.vault?.source ?? null,
      isObsidianVault: state.vault?.isVault ?? null,
      error: state.error,
      index: index
        ? {
            notes: index.stats.notes,
            totalBytes: index.stats.totalBytes,
            generatedAt: index.generatedAt,
            stale,
            indexDir: options.indexDir,
          }
        : null,
      writeAllow: options.writeAllow,
    }
  }

  // ── obsidian_status ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'obsidian_status',
    description:
      '查看 Obsidian 接入状态：当前连接的库、Obsidian 中已安装的全部库、以及工作区索引的新鲜度。排查"读不到笔记"时先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderStatus(value)),
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'obsidian_status', kind: 'other', rawInput: args }),
    async execute() {
      const current = status()
      const discovered = discoverVaults()
      return { ...current, registry: discovered.registry, discovered: discovered.vaults }
    },
  })

  // ── obsidian_list ──────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'obsidian_list',
    description:
      '列出 Obsidian 知识库中的笔记（元数据，不含正文）：标题、路径、frontmatter 域/状态、标签、摘要。可按 folder / domain / status / tag 过滤，用来先摸清库的结构再决定读哪几篇。正文请用 obsidian_read，全文检索用 obsidian_search。',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: '限定目录前缀，如 "notes" 或 "notes/2026"' },
        domain: { type: 'string', description: '按 frontmatter 的 domain 精确过滤，如 ruankao / pentest / meta' },
        status: { type: 'string', description: '按 frontmatter 的 status 精确过滤，如 draft / doing / done / review' },
        tag: { type: 'string', description: '按标签精确过滤，不带 # 号' },
        limit: { type: 'number', description: '最多返回多少篇，默认 50，上限 200' },
        offset: { type: 'number', description: '跳过前 N 篇，用于翻页' },
      },
      additionalProperties: true,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderNoteList(value)),
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'obsidian_list', kind: 'search', rawInput: args }),
    async execute(args = {}) {
      const index = ensure(false)
      const limit = Math.min(200, Math.max(1, asInt(args.limit, 50)))
      const offset = Math.max(0, asInt(args.offset, 0))
      const notes = index.notes.filter((note) => {
        if (args.folder) {
          const prefix = normalizeRel(args.folder)
          if (note.path !== prefix && !note.path.startsWith(`${prefix}/`)) return false
        }
        if (args.domain && String(note.frontmatter?.domain ?? '') !== String(args.domain)) return false
        if (args.status && String(note.frontmatter?.status ?? '') !== String(args.status)) return false
        if (args.tag) {
          const wanted = String(args.tag).replace(/^#/, '').toLowerCase()
          if (!note.tags.some((tag) => tag.toLowerCase() === wanted)) return false
        }
        return true
      })
      return {
        vault: state.vault.path,
        total: notes.length,
        offset,
        returned: Math.max(0, Math.min(limit, notes.length - offset)),
        notes: notes.slice(offset, offset + limit).map((note) => ({
          path: note.path,
          title: note.title,
          domain: note.frontmatter?.domain ?? null,
          status: note.frontmatter?.status ?? null,
          type: note.frontmatter?.type ?? null,
          topic: note.frontmatter?.topic ?? null,
          tags: note.tags,
          linksOut: note.links?.length ?? 0,
          linksIn: note.linksIn ?? 0,
          summary: note.summary,
        })),
      }
    },
  })

  // ── obsidian_read ──────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'obsidian_read',
    description:
      '读取 Obsidian 知识库中一篇笔记的正文，附带解析后的 frontmatter、标签、wikilink 出链与反向链接。path 为库内相对路径，可用 obsidian_search 或 obsidian_list 得到。大文件用 offset / limit 按行翻页。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径，如 "notes/第一篇笔记.md"' },
        offset: { type: 'number', description: '起始行号，从 1 开始，默认 1' },
        limit: { type: 'number', description: '最多返回多少行，默认 400，上限 2000' },
      },
      required: ['path'],
      additionalProperties: true,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderNote(value)),
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.path === 'string' ? args.path : 'obsidian_read',
      kind: 'read',
      rawInput: args,
      locations: typeof args?.path === 'string' ? [{ path: args.path }] : undefined,
    }),
    async execute(args = {}) {
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new Error('obsidian_read needs a non-empty "path". Use obsidian_list or obsidian_search to find one.')
      }
      const index = ensure(false)
      return readNote(state.vault.path, args.path, index, { offset: args.offset, limit: args.limit })
    },
  })

  // ── obsidian_search ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'obsidian_search',
    description:
      '在 Obsidian 知识库的全部笔记正文中做全文检索，返回命中的笔记、行号与上下文片段，按相关度排序。多个关键词以空格分隔（全部命中才算匹配）。可叠加 folder / domain / status / tag 过滤。用它定位"某个知识点写在哪"。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，多个词以空格分隔，全部命中才算匹配' },
        folder: { type: 'string', description: '限定目录前缀' },
        domain: { type: 'string', description: '按 frontmatter 的 domain 精确过滤' },
        status: { type: 'string', description: '按 frontmatter 的 status 精确过滤' },
        tag: { type: 'string', description: '按标签精确过滤，不带 # 号' },
        limit: { type: 'number', description: '最多返回多少篇，默认 20，上限 100' },
        context: { type: 'number', description: '每个关键词最多返回几行命中片段，默认 3，上限 20' },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderSearch(value)),
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'obsidian_search', kind: 'search', rawInput: args }),
    async execute(args = {}) {
      if (typeof args.query !== 'string' || !args.query.trim()) {
        throw new Error('obsidian_search needs a non-empty "query".')
      }
      const index = ensure(false)
      return searchVault(state.vault.path, index, args.query, args)
    },
  })

  // ── obsidian_sync ──────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'obsidian_sync',
    description:
      '重新扫描 Obsidian 库并刷新工作区索引（INDEX.md + index.json）。其余读取类工具会在库发生变化时自动增量重建索引，因此只在需要立刻看到新笔记、或想确认索引已落盘时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(renderSync(value)),
    },
    presentCall: (args) => ({ card: 'generic', title: 'obsidian_sync', kind: 'other', rawInput: args }),
    async execute() {
      const index = ensure(true)
      const files = syncToDisk()
      return {
        vault: state.vault.path,
        notes: index.stats.notes,
        totalBytes: index.stats.totalBytes,
        totalLines: index.stats.totalLines,
        generatedAt: index.generatedAt,
        byDomain: index.stats.byDomain,
        indexDir: options.indexDir,
        written: files ? [files.markdown, files.json] : [],
      }
    },
  })

  // ── obsidian_write ─────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'obsidian_write',
    description:
      '在 Obsidian 库中创建或追加一篇笔记。' +
      (options.writeAllow.length > 0
        ? `写入被限制在 ${options.writeAllow.map((p) => `"${p}"`).join('、')} 之内，越界会被直接拒绝。`
        : '当前未配置 writeAllow，写入处于禁用状态。') +
      '可选 frontmatter 对象会自动渲染成 YAML 头。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径，必须以 .md 结尾' },
        content: { type: 'string', description: '笔记正文（不含 frontmatter，frontmatter 用 frontmatter 参数传）' },
        mode: {
          type: 'string',
          enum: ['create', 'append', 'overwrite'],
          description: 'create（默认，已存在则报错）/ append（追加）/ overwrite（覆盖）',
        },
        frontmatter: {
          type: 'object',
          description:
            '该库约定的 frontmatter：type / domain / topic / status / tags / created。仅在正文尚未带 frontmatter 时插入。',
          additionalProperties: true,
        },
      },
      required: ['path', 'content'],
      additionalProperties: true,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) =>
        text(
          `${value.created ? '已创建' : value.mode === 'append' ? '已追加' : '已覆盖'}：${value.path}\n` +
            `字节数：${value.bytes} · 允许写入范围：${value.allowPrefixes.join('、') || '（未配置）'}`,
        ),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.path === 'string' ? args.path : 'obsidian_write',
      kind: 'edit',
      rawInput: args,
    }),
    async execute(args = {}) {
      if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('obsidian_write needs a non-empty "path".')
      if (typeof args.content !== 'string') throw new Error('obsidian_write needs "content" as a string.')
      if (!state.vault) state.vault = resolveVault(options.vault)

      let content = args.content
      const frontmatter = args.frontmatter
      if (frontmatter && typeof frontmatter === 'object' && !/^\uFEFF?---[ \t]*\r?\n/.test(content)) {
        content = `${renderFrontmatter(frontmatter)}${content.replace(/^\s+/, '')}`
      }
      const result = writeNote(state.vault.path, args.path, content, {
        mode: args.mode,
        allowPrefixes: options.writeAllow,
      })
      ensure(true)
      syncToDisk()
      return { ...result, allowPrefixes: options.writeAllow }
    },
  })

  // Connect on load so the workspace index exists before the first tool call.
  if (options.autoSync) {
    try {
      const index = ensure(true)
      syncToDisk()
      console.log(
        `[obsidian] connected ${state.vault.path} (${state.vault.source}) — ${index.stats.notes} notes, ${formatBytes(index.stats.totalBytes)}`,
      )
    } catch (error) {
      state.error = error?.message ?? String(error)
      console.error(`[obsidian] not connected: ${state.error}`)
    }
  }
}

// ── renderers: what the model actually reads ─────────────────────────────────

function renderStatus(value) {
  const lines = []
  if (value.connected) lines.push(`已连接：${value.vaultPath}（来源：${value.vaultSource}${value.isObsidianVault ? '' : '，警告：目录下没有 .obsidian'}）`)
  else lines.push(`未连接：${value.error ?? '未知错误'}`)
  if (value.index) {
    lines.push(
      `索引：${value.index.notes} 篇 · ${formatBytes(value.index.totalBytes)} · 生成于 ${value.index.generatedAt}` +
        ` · ${value.index.stale === true ? '**已过期**（调用 obsidian_sync 刷新）' : value.index.stale === false ? '最新' : '未校验'}`,
    )
    lines.push(`索引落盘目录：${value.index.indexDir ?? '（仅内存，未配置 indexDir）'}`)
  }
  lines.push(`AI 可写范围：${value.writeAllow.map((p) => `"${p}"`).join('、') || '（未配置，写入已禁用）'}`)
  if (value.registry) lines.push(`\nObsidian 库注册表：${value.registry}`)
  else lines.push('\n未找到 Obsidian 库注册表（obsidian.json），请检查 Obsidian 是否安装过。')
  lines.push(`Obsidian 中已发现的库（${value.discovered.length}）：`)
  for (const vault of value.discovered) {
    lines.push(
      `- ${vault.open ? '[当前打开] ' : ''}${vault.path}` +
        `${vault.exists ? '' : '（目录不存在）'}${vault.isVault ? '' : '（不是 Obsidian 库）'}` +
        `${vault.lastOpenedAt ? ` · 最近打开 ${vault.lastOpenedAt}` : ''}`,
    )
  }
  return lines.join('\n')
}

function renderNoteList(value) {
  const lines = [`库：${value.vault}`, `匹配 ${value.total} 篇，返回第 ${value.offset + 1}–${value.offset + value.returned} 篇`, '']
  for (const note of value.notes) {
    const meta = []
    if (note.domain) meta.push(`domain=${note.domain}`)
    if (note.status) meta.push(`status=${note.status}`)
    if (note.type) meta.push(`type=${note.type}`)
    if (note.linksOut || note.linksIn) meta.push(`→${note.linksOut} ←${note.linksIn}`)
    lines.push(`- ${note.path}`)
    lines.push(`  标题：${note.title}${meta.length ? ` · ${meta.join(' · ')}` : ''}`)
    if (note.tags.length) lines.push(`  标签：${note.tags.map((tag) => `#${tag}`).join(' ')}`)
    if (note.summary) lines.push(`  摘要：${note.summary}`)
  }
  return lines.join('\n')
}

function renderNote(value) {
  const lines = []
  lines.push(`${value.path} · ${value.title}`)
  const meta = []
  if (value.frontmatter?.domain) meta.push(`domain=${value.frontmatter.domain}`)
  if (value.frontmatter?.status) meta.push(`status=${value.frontmatter.status}`)
  if (value.frontmatter?.type) meta.push(`type=${value.frontmatter.type}`)
  if (value.frontmatter?.topic) meta.push(`topic=${value.frontmatter.topic}`)
  if (meta.length) lines.push(`frontmatter：${meta.join(' · ')}`)
  if (value.tags.length) lines.push(`标签：${value.tags.map((tag) => `#${tag}`).join(' ')}`)
  if (value.links?.length) {
    lines.push(`出链（${value.links.length}）：${value.links.map((link) => `[[${link.target}${link.heading ? `#${link.heading}` : ''}]]`).join(' ')}`)
  }
  if (value.backlinks?.length) lines.push(`反向链接（${value.backlinks.length}）：${value.backlinks.join(' · ')}`)
  lines.push(`共 ${value.totalLines} 行，本次显示第 ${value.offset}–${value.offset + value.lines.length - 1} 行${value.truncated ? '（已截断，用 offset 继续）' : ''}`)
  lines.push('─'.repeat(40))
  for (const line of value.lines) lines.push(`${String(line.number).padStart(5)}\t${line.text}`)
  return lines.join('\n')
}

function renderSearch(value) {
  const lines = [`检索："${value.query}" — 命中 ${value.total} 篇${value.truncated ? `，仅显示前 ${value.matches.length} 篇` : ''}`, '']
  for (const match of value.matches) {
    const meta = []
    if (match.domain) meta.push(`domain=${match.domain}`)
    if (match.status) meta.push(`status=${match.status}`)
    lines.push(`- ${match.path} — ${match.title} · 相关度 ${match.score}${meta.length ? ` · ${meta.join(' · ')}` : ''}`)
    for (const hit of match.lines) lines.push(`  ${String(hit.lineNumber).padStart(5)}  ${hit.line}`)
  }
  return lines.join('\n')
}

function renderSync(value) {
  const lines = [
    `已同步：${value.vault}`,
    `笔记 ${value.notes} 篇 · ${formatBytes(value.totalBytes)} · ${value.totalLines} 行 · 生成于 ${value.generatedAt}`,
    `domain 分布：${Object.entries(value.byDomain ?? {}).map(([key, count]) => `${key}=${count}`).join(' · ')}`,
  ]
  if (value.written.length) lines.push(`已写入：\n${value.written.map((file) => `- ${file}`).join('\n')}`)
  else lines.push('未配置 indexDir，索引仅存在于内存。')
  return lines.join('\n')
}
