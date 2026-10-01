/**
 * dsh-obsidian — vault core: discovery, parsing, indexing, search, read, write.
 *
 * Node builtins only. This plugin is loaded out-of-tree (by absolute path from
 * the profile patch), where importing `@deepseek-ai/*` depends on resolution
 * that position does not guarantee — so the tool definitions stay raw JSON
 * Schema and every helper lives here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** Directories never walked. `.obsidian` holds Obsidian's own state, not notes. */
export const DEFAULT_IGNORED_DIRS = [
  '.obsidian',
  '.claude',
  '.git',
  '.trash',
  '.smart-env',
  'node_modules',
]

const str = (value) => (value === undefined || value === null ? undefined : String(value))
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// ── paths ────────────────────────────────────────────────────────────────────

/** Vault-relative, forward-slashed: the form Obsidian itself uses. */
export function toRel(vaultPath, absPath) {
  return relative(vaultPath, absPath).split(sep).join('/')
}

/** Accept what a user or model writes, store one canonical form. */
export function normalizeRel(input) {
  let rel = String(input ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (rel.startsWith('/')) rel = rel.slice(1)
  return rel.replace(/\/+$/, '')
}

/** Resolve a vault-relative path, refusing anything that escapes the vault. */
export function safeJoin(vaultPath, relInput) {
  const root = resolve(vaultPath)
  const rel = normalizeRel(relInput)
  if (!rel) throw new Error('a vault-relative note path is required')
  if (/^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`"${relInput}" is not a vault-relative path`)
  }
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`"${relInput}" escapes the vault`)
  }
  return abs
}

// ── discovery ────────────────────────────────────────────────────────────────

/** Candidate locations of Obsidian's own vault registry, per platform. */
function registryCandidates() {
  const out = []
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'obsidian', 'obsidian.json'))
  out.push(join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json'))
  out.push(join(homedir(), '.config', 'obsidian', 'obsidian.json'))
  return out
}

/**
 * Read the vaults Obsidian itself knows about, so the user never has to paste
 * a path. Entries whose directory has since disappeared are dropped.
 */
export function discoverVaults() {
  for (const file of registryCandidates()) {
    if (!existsSync(file)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const vaults = []
    for (const [id, entry] of Object.entries(parsed?.vaults ?? {})) {
      const path = str(entry?.path)
      if (!path) continue
      let exists = false
      try {
        exists = statSync(path).isDirectory()
      } catch {
        exists = false
      }
      vaults.push({
        id,
        path,
        name: basename(path),
        exists,
        open: entry?.open === true,
        isVault: exists && existsSync(join(path, '.obsidian')),
        lastOpenedAt: typeof entry?.ts === 'number' ? new Date(entry.ts).toISOString() : null,
      })
    }
    vaults.sort((a, b) => Number(b.open) - Number(a.open) || (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
    return { registry: file, vaults }
  }
  return { registry: null, vaults: [] }
}

/** The configured vault, or the one Obsidian currently has open, or the newest. */
export function resolveVault(configuredPath) {
  const wanted = str(configuredPath)?.trim()
  if (wanted) {
    const path = resolve(wanted)
    if (!existsSync(path)) throw new Error(`configured vault does not exist: ${path}`)
    if (!statSync(path).isDirectory()) throw new Error(`configured vault is not a directory: ${path}`)
    return { path, source: 'config', isVault: existsSync(join(path, '.obsidian')) }
  }
  const { vaults } = discoverVaults()
  const found = vaults.find((v) => v.exists && v.open) ?? vaults.find((v) => v.exists)
  if (!found) throw new Error('no Obsidian vault is connected: set the plugin config "vault" to a vault path')
  return { path: found.path, source: found.open ? 'obsidian-open' : 'obsidian-registry', isVault: found.isVault }
}

// ── note parsing ─────────────────────────────────────────────────────────────

export function splitFrontmatter(text) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { raw: null, body: text }
  return { raw: match[1], body: text.slice(match[0].length) }
}

function stripQuotes(value) {
  const text = value.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  }
  return text
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text === '') return ''
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^-?\d*\.\d+$/.test(text)) return Number(text)
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((part) => stripQuotes(part))
      .filter((part) => part !== '')
  }
  return stripQuotes(text)
}

/**
 * A tolerant YAML subset: the scalar, inline-list, and block-list forms
 * Obsidian frontmatter actually uses. Anything more exotic is left as text
 * rather than guessed at.
 */
export function parseYamlLite(text) {
  const out = {}
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) {
      i += 1
      continue
    }
    const match = /^([A-Za-z0-9_$.-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) {
      i += 1
      continue
    }
    const key = match[1]
    const rest = match[2]
    if (rest === '' || rest === '|' || rest === '>') {
      const items = []
      const block = []
      let j = i + 1
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        const inner = lines[j].trim()
        if (rest === '' && /^-\s+/.test(inner)) items.push(parseScalar(inner.replace(/^-\s+/, '')))
        else block.push(inner)
        j += 1
      }
      if (items.length > 0) out[key] = items
      else if (block.length > 0) out[key] = block.join(rest === '>' ? ' ' : '\n')
      else out[key] = rest === '' ? null : ''
      i = j
      continue
    }
    out[key] = parseScalar(rest)
    i += 1
  }
  return out
}

const WIKILINK_RE = /(!?)\[\[([^[\]]+?)\]\]/g
const INLINE_TAG_RE = /(?<=^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gmu

function collectLinks(body) {
  const links = []
  const seen = new Set()
  WIKILINK_RE.lastIndex = 0
  let match
  while ((match = WIKILINK_RE.exec(body))) {
    // A markdown table escapes its own delimiter, so a table-hosted wikilink
    // arrives as `[[target\|alias]]`. Unescape before splitting on the pipe, or
    // the target keeps a trailing backslash and never resolves — Obsidian itself
    // reads the escaped form as an ordinary link.
    let inner = match[2].replace(/\\\|/g, '|')
    let alias = null
    let heading = null
    const pipe = inner.indexOf('|')
    if (pipe >= 0) {
      alias = inner.slice(pipe + 1).trim()
      inner = inner.slice(0, pipe)
    }
    const hash = inner.indexOf('#')
    if (hash >= 0) {
      heading = inner.slice(hash + 1).trim()
      inner = inner.slice(0, hash)
    }
    const target = inner.trim()
    const key = `${target}\u0000${heading ?? ''}\u0000${alias ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ target, heading, alias, embed: match[1] === '!' })
  }
  return links
}

function collectTags(frontmatter, body) {
  const tags = new Set()
  const declared = frontmatter?.tags
  if (Array.isArray(declared)) for (const tag of declared) tags.add(String(tag).replace(/^#/, ''))
  else if (typeof declared === 'string' && declared.trim()) {
    for (const tag of declared.trim().split(/[,\s]+/)) if (tag) tags.add(tag.replace(/^#/, ''))
  }
  INLINE_TAG_RE.lastIndex = 0
  let match
  while ((match = INLINE_TAG_RE.exec(body))) tags.add(match[1])
  return [...tags]
}

function collectHeadings(body) {
  const out = []
  const lines = body.split(/\r?\n/)
  let fence = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch) {
      fence = fence ? null : fenceMatch[1]
      continue
    }
    if (fence) continue
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line)
    if (match) out.push({ level: match[1].length, text: match[2].replace(/[ \t]+#+$/, '').trim(), line: i + 1 })
  }
  return out
}

/** First real paragraph after the title: what the note is about, in one line. */
function summarize(body, max = 200) {
  const lines = body.split(/\r?\n/)
  const buffer = []
  let fence = null
  for (const raw of lines) {
    const line = raw.trim()
    const fenceMatch = /^(```|~~~)/.exec(line)
    if (fenceMatch) {
      fence = fence ? null : fenceMatch[1]
      continue
    }
    if (fence) continue
    if (!line) {
      if (buffer.length > 0) break
      continue
    }
    if (/^#{1,6}[ \t]/.test(line)) {
      if (buffer.length > 0) break
      continue
    }
    if (/^>/.test(line)) {
      buffer.push(line.replace(/^>\s?/, ''))
      continue
    }
    if (/^(\||\s*[-*+]\s|\s*\d+\.\s|-{3,}|={3,}|<)/.test(line)) {
      if (buffer.length > 0) break
      continue
    }
    buffer.push(line)
  }
  const text = buffer.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function parseNote(text, relPath) {
  const split = splitFrontmatter(text)
  const frontmatter = split.raw === null ? {} : parseYamlLite(split.raw)
  const body = split.body
  const headings = collectHeadings(body)
  const name = basename(relPath).replace(/\.md$/i, '')
  return {
    path: relPath,
    title: headings.find((heading) => heading.level === 1)?.text || name,
    name,
    frontmatter,
    tags: collectTags(frontmatter, body),
    links: collectLinks(body),
    headings,
    summary: summarize(body),
    lines: body.split(/\r?\n/).length,
  }
}

// ── index ────────────────────────────────────────────────────────────────────

export function scanVault(vaultPath, options = {}) {
  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoreDirs ?? [])])
  const files = []
  const walk = (dir, depth) => {
    if (depth > 24) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue
        walk(abs, depth + 1)
        continue
      }
      if (!/\.md$/i.test(entry.name)) continue
      let info
      try {
        info = statSync(abs)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      files.push({ path: toRel(vaultPath, abs), absPath: abs, size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  walk(vaultPath, 0)
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
  return files
}

/** Cheap change detector: count + newest mtime + total bytes. */
export function signatureOf(files) {
  let maxMtimeMs = 0
  let totalBytes = 0
  for (const file of files) {
    if (file.mtimeMs > maxMtimeMs) maxMtimeMs = file.mtimeMs
    totalBytes += file.size
  }
  return { count: files.length, maxMtimeMs: Math.round(maxMtimeMs), totalBytes }
}

export function sameSignature(a, b) {
  return (
    !!a &&
    !!b &&
    a.count === b.count &&
    a.maxMtimeMs === b.maxMtimeMs &&
    a.totalBytes === b.totalBytes
  )
}

export function buildIndexFromFiles(vaultPath, files, options = {}) {
  const notes = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file.absPath, 'utf8')
    } catch {
      continue
    }
    const note = parseNote(text, file.path)
    note.size = file.size
    note.mtimeMs = Math.round(file.mtimeMs)
    notes.push(note)
  }

  // Wikilinks name a note by path or by bare title; index both spellings.
  const keyToPath = new Map()
  for (const note of notes) {
    const noExt = note.path.replace(/\.md$/i, '')
    keyToPath.set(noExt.toLowerCase(), note.path)
    keyToPath.set(basename(noExt).toLowerCase(), note.path)
  }

  const backlinks = {}
  const unresolved = {}
  for (const note of notes) {
    for (const link of note.links) {
      const target = keyToPath.get(link.target.replace(/\.md$/i, '').toLowerCase())
      if (target) {
        if (!backlinks[target]) backlinks[target] = []
        if (!backlinks[target].includes(note.path)) backlinks[target].push(note.path)
      } else if (link.target) {
        if (!unresolved[link.target]) unresolved[link.target] = []
        if (!unresolved[link.target].includes(note.path)) unresolved[link.target].push(note.path)
      }
    }
  }

  const byDomain = {}
  const byStatus = {}
  const byFolder = {}
  const tagCounts = {}
  for (const note of notes) {
    const domain = str(note.frontmatter?.domain) || '(未标注)'
    const status = str(note.frontmatter?.status) || '(未标注)'
    const folder = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '(根目录)'
    byDomain[domain] = (byDomain[domain] ?? 0) + 1
    byStatus[status] = (byStatus[status] ?? 0) + 1
    byFolder[folder] = (byFolder[folder] ?? 0) + 1
    note.linksIn = backlinks[note.path]?.length ?? 0
    for (const tag of note.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1
  }

  return {
    version: 1,
    vaultPath,
    generatedAt: new Date().toISOString(),
    ignoredDirs: [...DEFAULT_IGNORED_DIRS, ...(options.ignoreDirs ?? [])],
    signature: signatureOf(files),
    stats: {
      notes: notes.length,
      totalBytes: notes.reduce((sum, note) => sum + (note.size ?? 0), 0),
      totalLines: notes.reduce((sum, note) => sum + (note.lines ?? 0), 0),
      byDomain,
      byStatus,
      byFolder,
      tags: Object.fromEntries(Object.entries(tagCounts).sort((a, b) => b[1] - a[1])),
    },
    notes,
    backlinks,
    unresolved,
  }
}

export function buildIndex(vaultPath, options = {}) {
  return buildIndexFromFiles(vaultPath, scanVault(vaultPath, options), options)
}

// ── query ────────────────────────────────────────────────────────────────────

function matchesFilters(note, options) {
  const folder = str(options.folder)?.trim()
  if (folder) {
    const prefix = normalizeRel(folder)
    if (note.path !== prefix && !note.path.startsWith(`${prefix}/`)) return false
  }
  const domain = str(options.domain)?.trim()
  if (domain && str(note.frontmatter?.domain) !== domain) return false
  const status = str(options.status)?.trim()
  if (status && str(note.frontmatter?.status) !== status) return false
  const tag = str(options.tag)?.trim()
  if (tag && !note.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) return false
  return true
}

/**
 * A window around the first occurrence of the term. The term is located in the
 * collapsed text rather than passed in as an index into the raw line: an index
 * taken from the raw line does not survive the whitespace collapsing and
 * trimming above, which shifts every position after the first run of spaces.
 */
function snippet(line, term, width = 160) {
  const text = line.replace(/\s+/g, ' ').trim()
  if (text.length <= width) return text
  const at = text.toLowerCase().indexOf(term.toLowerCase())
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor((width - term.length) / 2))
  const cut = text.slice(start, start + width)
  return `${start > 0 ? '…' : ''}${cut}${start + width < text.length ? '…' : ''}`
}

/**
 * Live full-text search over note bodies, filtered by the index's metadata.
 * Bodies are read per call rather than cached so results are never stale.
 */
export function searchVault(vaultPath, index, query, options = {}) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (terms.length === 0) throw new Error('query must contain at least one term')

  const limit = clamp(Number(options.limit) || 20, 1, 100)
  const linesPerTerm = clamp(Number(options.context) || 3, 1, 20)
  const results = []

  for (const note of index.notes) {
    if (!matchesFilters(note, options)) continue
    let text
    try {
      text = readFileSync(safeJoin(vaultPath, note.path), 'utf8')
    } catch {
      continue
    }
    const titleHay = note.title.toLowerCase()
    const nameHay = note.name.toLowerCase()
    const tagHay = note.tags.join(' ').toLowerCase()
    const topicHay = String(note.frontmatter?.topic ?? '').toLowerCase()
    const lines = text.split(/\r?\n/)
    const lower = lines.map((line) => line.toLowerCase())

    let score = 0
    let everyTermMatched = true
    const hits = []

    for (const term of terms) {
      let occurrences = 0
      const lineHits = []
      for (let i = 0; i < lower.length; i += 1) {
        const at = lower[i].indexOf(term)
        if (at < 0) continue
        occurrences += 1
        if (lineHits.length < linesPerTerm) {
          lineHits.push({ lineNumber: i + 1, line: snippet(lines[i], term) })
        }
      }
      const inTitle = titleHay.includes(term) || nameHay.includes(term)
      const inTag = tagHay.includes(term)
      const inTopic = topicHay.includes(term)
      if (!inTitle && !inTag && !inTopic && occurrences === 0) {
        everyTermMatched = false
        break
      }
      score += (inTitle ? 12 : 0) + (inTag ? 6 : 0) + (inTopic ? 4 : 0) + Math.min(occurrences, 20)
      hits.push(...lineHits)
    }

    if (!everyTermMatched) continue
    hits.sort((a, b) => a.lineNumber - b.lineNumber)
    results.push({
      path: note.path,
      title: note.title,
      // `null`, never `undefined`: a tool result must survive JSON round-tripping
      // losslessly, and an absent frontmatter key is exactly where `undefined`
      // would otherwise leak into the canonical value.
      domain: str(note.frontmatter?.domain) ?? null,
      status: str(note.frontmatter?.status) ?? null,
      tags: note.tags,
      score,
      lines: hits,
    })
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'zh'))
  return { query: String(query), total: results.length, truncated: results.length > limit, matches: results.slice(0, limit) }
}

export function readNote(vaultPath, relInput, index, options = {}) {
  const rel = normalizeRel(relInput)
  const abs = safeJoin(vaultPath, rel)
  if (!existsSync(abs)) throw new Error(`no such note in the vault: ${rel}`)
  const text = readFileSync(abs, 'utf8')
  const parsed = parseNote(text, rel)
  const all = text.split(/\r?\n/)
  const offset = clamp(Number(options.offset) || 1, 1, Math.max(1, all.length))
  const limit = clamp(Number(options.limit) || 400, 1, 2000)
  const slice = all.slice(offset - 1, offset - 1 + limit)
  return {
    ...parsed,
    offset,
    totalLines: all.length,
    truncated: offset - 1 + slice.length < all.length,
    backlinks: index?.backlinks?.[rel] ?? [],
    lines: slice.map((line, i) => ({ number: offset + i, text: line })),
  }
}

/** Create, append to, or overwrite one note — inside the allowlisted prefixes only. */
export function writeNote(vaultPath, relInput, content, options = {}) {
  const rel = normalizeRel(relInput)
  if (!/\.md$/i.test(rel)) throw new Error('a note path must end with .md')

  const allow = options.allowPrefixes ?? []
  const permitted = allow.some((prefix) => {
    const clean = normalizeRel(prefix)
    return rel === clean || rel.startsWith(`${clean}/`)
  })
  if (!permitted) {
    throw new Error(
      allow.length === 0
        ? `refusing to write "${rel}": agent writes are disabled — set the plugin config "writeAllow" to the vault-relative prefixes this agent may write`
        : `refusing to write "${rel}": this vault allows agent writes only under ${allow.map((p) => `"${p}"`).join(', ')}`,
    )
  }

  const abs = safeJoin(vaultPath, rel)
  const existed = existsSync(abs)
  const mode = ['create', 'append', 'overwrite'].includes(options.mode) ? options.mode : 'create'
  if (mode === 'create' && existed) {
    throw new Error(`"${rel}" already exists; pass mode "append" or "overwrite" to change it`)
  }

  let final = String(content ?? '')
  if (mode === 'append' && existed) {
    final = `${readFileSync(abs, 'utf8').replace(/\s*$/, '')}\n\n${final}`
  }

  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, final, 'utf8')
  return { path: rel, mode, created: !existed, bytes: Buffer.byteLength(final, 'utf8') }
}

// ── generated index file ─────────────────────────────────────────────────────

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function countTable(counts) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (rows.length === 0) return '_（无）_\n'
  return `${rows.map(([key, value]) => `- \`${key}\`：${value}`).join('\n')}\n`
}

/**
 * The workspace-side index. Metadata only — note bodies stay in the vault and
 * are fetched on demand, so this file never becomes a stale second copy.
 */
export function renderIndexMarkdown(index) {
  const { stats } = index
  const out = []
  out.push('# Obsidian 知识库索引')
  out.push('')
  out.push('> 本文件由 `dsh-obsidian` 插件生成，**请勿手工编辑**；刷新请调用 `obsidian_sync` 工具。')
  out.push('> 这里只有元数据。读全文用 `obsidian_read`，检索用 `obsidian_search`。')
  out.push('')
  out.push('| 项 | 值 |')
  out.push('| --- | --- |')
  out.push(`| 库路径 | \`${index.vaultPath}\` |`)
  out.push(`| 笔记数 | ${stats.notes} |`)
  out.push(`| 正文总量 | ${formatBytes(stats.totalBytes)} · ${stats.totalLines} 行 |`)
  out.push(`| 索引生成时间 | ${index.generatedAt} |`)
  out.push(`| 已跳过目录 | ${index.ignoredDirs.map((dir) => `\`${dir}\``).join('、')} |`)
  out.push('')

  out.push('## 按 domain')
  out.push('')
  out.push(countTable(stats.byDomain))
  out.push('## 按 status')
  out.push('')
  out.push(countTable(stats.byStatus))
  out.push('## 按目录')
  out.push('')
  out.push(countTable(stats.byFolder))
  out.push('## 标签')
  out.push('')
  out.push(countTable(stats.tags))
  out.push('')

  out.push('## 笔记清单')
  out.push('')
  const folders = new Map()
  for (const note of index.notes) {
    const folder = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '(根目录)'
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder).push(note)
  }
  for (const [folder, notes] of [...folders.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`### ${folder} (${notes.length})`)
    out.push('')
    for (const note of notes) {
      const meta = []
      if (note.frontmatter?.domain) meta.push(`domain=${note.frontmatter.domain}`)
      if (note.frontmatter?.status) meta.push(`status=${note.frontmatter.status}`)
      if (note.frontmatter?.type) meta.push(`type=${note.frontmatter.type}`)
      if (note.links?.length) meta.push(`→${note.links.length}`)
      if (note.linksIn) meta.push(`←${note.linksIn}`)
      out.push(`- \`${note.path}\``)
      out.push(`  - **${note.title}**${meta.length ? ` · ${meta.join(' · ')}` : ''}`)
      if (note.tags.length > 0) out.push(`  - 标签：${note.tags.map((tag) => `#${tag}`).join(' ')}`)
      if (note.summary) out.push(`  - ${note.summary}`)
    }
    out.push('')
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}
