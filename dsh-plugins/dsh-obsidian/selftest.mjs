/**
 * dsh-obsidian self-test.
 *
 * Portable by construction: it builds its own vault in a temp directory and
 * removes it afterwards, so it never reads or writes a real vault and carries
 * no deployment-specific expectations.
 *
 * The fixture is deliberately awkward where it matters — a nested folder, a
 * note with no frontmatter, a zero-byte note, a fenced block containing a `#`
 * line, an inline tag after a space, a line far longer than the snippet width,
 * a wikilink that resolves by bare filename, and two links that resolve to
 * nothing.
 *
 *   node selftest.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply as applyPlugin } from './index.js'
import {
  buildIndex,
  discoverVaults,
  normalizeRel,
  parseNote,
  parseYamlLite,
  readNote,
  renderIndexMarkdown,
  resolveVault,
  safeJoin,
  sameSignature,
  scanVault,
  searchVault,
  signatureOf,
  splitFrontmatter,
  writeNote,
} from './vault.js'

// ── the fixture ──────────────────────────────────────────────────────────────

/** Directories the deployment asks to skip, on top of the built-in ones. */
const IGNORE = ['archives']
/** The only prefix the agent may write to in this fixture. */
const ALLOW = ['inbox']

const FILES = {
  '00-index.md': [
    '---',
    'type: note',
    'domain: meta',
    'status: done',
    'tags: [索引, 总览]',
    'created: 2026-01-01',
    '---',
    '',
    '# 知识库索引',
    '',
    '> 入口说明：从这里进入各域。',
    '',
    '- [[notes/alpha]]',
    '- [[notes/beta|第二个]]',
    '- [[notes/deep/gamma#小节标题]]',
    '- [[不存在的笔记]]',
    '',
  ].join('\n'),

  'notes/alpha.md': [
    '---',
    'type: note',
    'domain: research',
    'topic: 入侵检测',
    'status: done',
    'tags: [研究, 入侵检测]',
    'created: 2026-01-02',
    '---',
    '',
    '# Alpha 笔记',
    '',
    '> 定位：**误用检测 vs 异常检测**是核心。',
    '',
    '正文提到入侵检测与安全审计的配合。',
    '',
    '## 小节',
    '',
    '- 要点一',
    '- 要点二',
    '',
  ].join('\n'),

  'notes/beta.md': [
    '---',
    'type: note',
    'domain: research',
    'topic: 安全审计',
    'status: draft',
    'tags: [研究, 安全审计]',
    'created: 2026-01-03',
    '---',
    '',
    '# Beta 笔记',
    '',
    '安全审计与入侵检测互补。',
    '',
    '关联：[[alpha]]',
    '',
  ].join('\n'),

  'notes/no-frontmatter.md': [
    '# 无 Frontmatter',
    '',
    '这一段没有 frontmatter：既没有 domain/status，也和安全无关。 #行内标签 在这里。',
    '',
    '~~~text',
    '# 这行在代码围栏里，不该被当成标题或标签',
    '~~~',
    '',
    '#标签/带斜杠 也在这里。',
    '',
  ].join('\n'),

  'notes/empty.md': '',

  'notes/deep/gamma.md': [
    '---',
    'type: note',
    'domain: ops',
    'status: review',
    'tags: [运维]',
    'created: 2026-01-04',
    '---',
    '',
    '# Gamma 笔记',
    '',
    '安全运维的日常记录：回到 [[alpha]] 看看，另外 [[记录：无处可去]] 解析不了。',
    '',
    `长行：${'安全基线检查项。'.repeat(30)}`,
    '',
  ].join('\n'),

  'inbox/draft.md': [
    '---',
    'type: note',
    'domain: meta',
    'status: draft',
    'tags: [草稿]',
    'created: 2026-01-05',
    '---',
    '',
    '# 草稿',
    '',
    '安全相关的半成品：片段与摘录。',
    '',
  ].join('\n'),

  // Skipped because the deployment adds it to ignoreDirs.
  'archives/old.md': ['---', 'domain: archive', '---', '', '# 归档笔记', '', '不该出现在索引里。', ''].join('\n'),
  // Skipped because `.obsidian` is a built-in ignored directory.
  '.obsidian/plugins/graph.md': ['# 插件数据', '', '不该出现在索引里。', ''].join('\n'),
}

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-obsidian-vault-'))
const VAULT = join(FIXTURE_ROOT, 'vault')
for (const [rel, content] of Object.entries(FILES)) {
  const abs = join(VAULT, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  ✗ ${label}\n      ${error?.message?.split('\n')[0]}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  ✗ ${label}\n      ${error?.message?.split('\n')[0]}`)
  }
}

function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b)
    return true
  } catch {
    return false
  }
}

/**
 * A tool result must survive JSON round-tripping exactly. An `undefined`
 * anywhere in the canonical value makes the harness reject the whole call with
 * "value is not lossless JSON" — a failure the tool's own assertions cannot
 * see, which is exactly how one reached a live call once. Every invocation
 * below goes through a runner, so losslessness and rendering are checked on
 * every path instead of being asserted by hand.
 */
function assertLossless(label, value) {
  if (deepEqual(JSON.parse(JSON.stringify(value ?? null)), value)) return
  const offenders = []
  const walk = (node, at) => {
    if (node === undefined) return offenders.push(at || '(root)')
    if (typeof node === 'number' && !Number.isFinite(node)) return offenders.push(`${at} = ${node}`)
    if (['function', 'symbol', 'bigint'].includes(typeof node)) return offenders.push(`${at} = ${typeof node}`)
    if (node instanceof Date) return offenders.push(`${at} = Date`)
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${at}[${index}]`))
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], at ? `${at}.${key}` : key)
    }
  }
  walk(value, '')
  throw new Error(
    `${label}: canonical value is not lossless JSON — offending paths: ${offenders.slice(0, 8).join(', ') || '(unknown)'}`,
  )
}

const makeRunner =
  (lookup) =>
  async (toolName, args = {}, label = toolName) => {
    const definition = lookup(toolName)
    const value = await definition.execute(args)
    assertLossless(label, value)
    const blocks = definition.output.render(args, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${label}: render returned no content`)
    for (const block of blocks) {
      assert.equal(block.type, 'text', `${label}: render block type`)
      assert.equal(typeof block.text, 'string', `${label}: render block text`)
    }
    return { value, rendered: blocks.map((block) => block.text).join('\n') }
  }

// ── 1. discovery ─────────────────────────────────────────────────────────────

console.log('\n── 1. 库发现 ──────────────────────────────────────────────')
const discovered = discoverVaults()
check('discoverVaults 返回 { registry, vaults } 结构', () => {
  assert.ok('registry' in discovered, 'registry key missing')
  assert.ok(Array.isArray(discovered.vaults), 'vaults must be an array')
  for (const vault of discovered.vaults) {
    assert.equal(typeof vault.id, 'string')
    assert.equal(typeof vault.path, 'string')
    assert.equal(typeof vault.exists, 'boolean')
    assert.equal(typeof vault.open, 'boolean')
    assert.equal(typeof vault.isVault, 'boolean')
    // An absent registry timestamp must be null, never undefined: this value
    // travels through a tool result.
    assert.ok(vault.lastOpenedAt === null || typeof vault.lastOpenedAt === 'string')
    assertLossless('discoverVaults entry', vault)
  }
})
check('未配置时自动选中一个存在的库（没有库时明确报错）', () => {
  const auto =
    discovered.vaults.find((vault) => vault.exists && vault.open) ??
    discovered.vaults.find((vault) => vault.exists)
  if (!auto) {
    assert.throws(() => resolveVault(null), /no Obsidian vault is connected/)
    return
  }
  const resolved = resolveVault(null)
  assert.equal(resolved.path, auto.path)
  assert.ok(['obsidian-open', 'obsidian-registry'].includes(resolved.source))
})
check('显式配置优先于自动发现', () => {
  const resolved = resolveVault(VAULT)
  assert.equal(resolved.path, VAULT)
  assert.equal(resolved.source, 'config')
  assert.equal(resolved.isVault, true, 'the fixture carries a .obsidian directory')
})
check('配置的路径不存在时明确报错', () =>
  assert.throws(() => resolveVault(join(VAULT, 'does-not-exist')), /does not exist/))

// ── 2. parsing ───────────────────────────────────────────────────────────────

console.log('\n── 2. frontmatter / 正文解析 ───────────────────────────────')
check('拆出 frontmatter 与正文', () => {
  const split = splitFrontmatter('---\na: 1\n---\nbody\n')
  assert.equal(split.raw, 'a: 1')
  assert.equal(split.body, 'body\n')
})
check('无 frontmatter 时原样返回正文', () => {
  const split = splitFrontmatter('# 标题\n正文')
  assert.equal(split.raw, null)
  assert.equal(split.body, '# 标题\n正文')
})
check('YAML 子集：标量 / 内联数组 / 块数组 / 引号 / 布尔 / 数字', () => {
  const parsed = parseYamlLite(
    ['type: note', 'tags: [甲, 乙]', 'list:', '  - a', '  - b', 'quoted: "x: y"', 'ok: true', 'n: 7'].join('\n'),
  )
  assert.equal(parsed.type, 'note')
  assert.deepEqual(parsed.tags, ['甲', '乙'])
  assert.deepEqual(parsed.list, ['a', 'b'])
  assert.equal(parsed.quoted, 'x: y')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.n, 7)
})
check('解析笔记：标题、domain、摘要、wikilink 别名与锚点', () => {
  const note = parseNote(readFileSync(join(VAULT, '00-index.md'), 'utf8'), '00-index.md')
  assert.equal(note.frontmatter.domain, 'meta')
  assert.equal(note.frontmatter.status, 'done')
  assert.equal(note.title, '知识库索引')
  assert.deepEqual(note.tags, ['索引', '总览'])
  assert.equal(note.summary, '入口说明：从这里进入各域。')
  assert.ok(note.links.some((link) => link.target === 'notes/alpha'))
  assert.ok(note.links.some((link) => link.target === 'notes/beta' && link.alias === '第二个'))
  assert.ok(note.links.some((link) => link.target === 'notes/deep/gamma' && link.heading === '小节标题'))
})
check('行内 #标签 被采集，而 # 标题与围栏内的 # 行不被误判', () => {
  const note = parseNote(readFileSync(join(VAULT, 'notes/no-frontmatter.md'), 'utf8'), 'notes/no-frontmatter.md')
  assert.deepEqual(note.tags, ['行内标签', '标签/带斜杠'])
  assert.deepEqual(note.headings.map((heading) => heading.text), ['无 Frontmatter'])
})
check('``` 三反引号围栏同样被识别', () => {
  const note = parseNote(['# 真标题', '', '```js', '# 假标题', '```', '', '正文。'].join('\n'), 'x.md')
  assert.deepEqual(note.headings.map((heading) => heading.text), ['真标题'])
})
check('没有 H1 时标题回退到文件名，空笔记不编造摘要', () => {
  const note = parseNote('', 'notes/empty.md')
  assert.equal(note.title, 'empty')
  assert.equal(note.summary, '')
  assert.equal(note.headings.length, 0)
})
// Regression: a markdown table escapes its own delimiter, so a table-hosted
// wikilink is written `[[target\|alias]]`. Obsidian reads that as an ordinary
// link; a parser that does not unescape it keeps a trailing backslash in the
// target, the link never resolves, and the missing backlink is silent.
check('表格里转义竖线的 wikilink 仍解析出正确目标与别名', () => {
  const note = parseNote(
    ['| 域 | 入口 |', '| --- | --- |', '| A | [[notes/alpha\\|Alpha 笔记]] |', ''].join('\n'),
    'x.md',
  )
  assert.equal(note.links.length, 1)
  assert.equal(note.links[0].target, 'notes/alpha')
  assert.equal(note.links[0].alias, 'Alpha 笔记')
})
check('转义竖线不影响锚点与无别名链接', () => {
  const note = parseNote('| a |\n| --- |\n| [[目标#小节\\|别名]] | [[另一个]] |\n', 'x.md')
  assert.equal(note.links[0].target, '目标')
  assert.equal(note.links[0].heading, '小节')
  assert.equal(note.links[0].alias, '别名')
  assert.equal(note.links[1].target, '另一个')
  assert.equal(note.links[1].alias, null)
})

// ── 3. index ─────────────────────────────────────────────────────────────────

console.log('\n── 3. 全库索引 ─────────────────────────────────────────────')
const index = buildIndex(VAULT, { ignoreDirs: IGNORE })
check('索引到 7 篇（9 个 md 中排除 1 个默认忽略目录 + 1 个配置忽略目录）', () =>
  assert.equal(index.stats.notes, 7, JSON.stringify(index.notes.map((note) => note.path))))
check('.obsidian 与配置的 ignoreDirs 都被跳过', () =>
  assert.ok(
    index.notes.every((note) => !note.path.startsWith('.obsidian/') && !note.path.startsWith('archives/')),
    JSON.stringify(index.notes.map((note) => note.path)),
  ))
check('按目录统计', () =>
  assert.deepEqual(index.stats.byFolder, { '(根目录)': 1, inbox: 1, notes: 4, 'notes/deep': 1 }))
check('按 domain 统计（缺失的记为「未标注」）', () =>
  assert.deepEqual(index.stats.byDomain, { '(未标注)': 2, meta: 2, ops: 1, research: 2 }))
check('按 status 统计', () =>
  assert.deepEqual(index.stats.byStatus, { '(未标注)': 2, done: 2, draft: 2, review: 1 }))
check('标签计数', () => {
  assert.equal(index.stats.tags['研究'], 2)
  assert.equal(index.stats.tags['索引'], 1)
  assert.equal(index.stats.tags['行内标签'], 1)
  assert.equal(index.stats.tags['标签/带斜杠'], 1)
})
check('有内容的笔记都有标题与摘要', () => {
  const missing = index.notes.filter((note) => !note.title)
  assert.equal(missing.length, 0, `${missing.length} notes without a title`)
  const noSummary = index.notes.filter((note) => note.size > 0 && !note.summary)
  assert.equal(noSummary.length, 0, noSummary.map((note) => note.path).join(', '))
})
check('wikilink 解析：路径写法与裸文件名写法命中同一篇笔记', () => {
  assert.deepEqual(index.backlinks['notes/alpha.md'], ['00-index.md', 'notes/beta.md', 'notes/deep/gamma.md'])
  assert.deepEqual(index.backlinks['notes/beta.md'], ['00-index.md'])
  assert.deepEqual(index.backlinks['notes/deep/gamma.md'], ['00-index.md'])
})
check('反向链接的键都是库内真实存在的笔记', () => {
  const paths = new Set(index.notes.map((note) => note.path))
  assert.equal(Object.keys(index.backlinks).filter((key) => !paths.has(key)).length, 0)
})
check('指向不存在笔记的链接进入 unresolved，而不是 backlinks', () => {
  assert.deepEqual(Object.keys(index.unresolved).sort(), ['不存在的笔记', '记录：无处可去'])
  assert.deepEqual(index.unresolved['不存在的笔记'], ['00-index.md'])
  const paths = new Set(index.notes.map((note) => note.path))
  for (const target of Object.keys(index.unresolved)) assert.ok(!paths.has(target))
})
check('每条索引项都带 linksIn 计数', () =>
  assert.deepEqual(
    Object.fromEntries(index.notes.map((note) => [note.path, note.linksIn])),
    {
      '00-index.md': 0,
      'inbox/draft.md': 0,
      'notes/alpha.md': 3,
      'notes/beta.md': 1,
      'notes/deep/gamma.md': 1,
      'notes/empty.md': 0,
      'notes/no-frontmatter.md': 0,
    },
  ))
check('索引签名可用于变更检测', () => {
  assert.equal(index.signature.count, 7)
  assert.ok(index.signature.maxMtimeMs > 0)
  assert.ok(index.signature.totalBytes > 0)
  assert.ok(sameSignature(index.signature, signatureOf(scanVault(VAULT, { ignoreDirs: IGNORE }))))
  assert.ok(!sameSignature(index.signature, { ...index.signature, count: 8 }))
})
check('渲染出的 INDEX.md 含库路径、统计与笔记清单', () => {
  const md = renderIndexMarkdown(index)
  assert.ok(md.includes(VAULT), 'vault path missing')
  assert.ok(md.includes('notes/alpha.md'), 'note list missing')
  assert.ok(md.includes('## 按 domain'), 'domain section missing')
  assert.ok(md.includes('## 标签'), 'tag section missing')
  assert.ok(md.includes('请勿手工编辑'), 'generated-warning missing')
})

// ── 4. reading ───────────────────────────────────────────────────────────────

console.log('\n── 4. 读取 ─────────────────────────────────────────────────')
check('读取全文并带行号，frontmatter 与反向链接一并返回', () => {
  const note = readNote(VAULT, 'notes/alpha.md', index)
  assert.equal(note.lines[0].number, 1)
  assert.equal(note.lines[0].text, '---')
  assert.equal(note.frontmatter.domain, 'research')
  assert.equal(note.title, 'Alpha 笔记')
  assert.equal(note.backlinks.length, 3)
  assert.equal(note.truncated, false)
})
check('offset / limit 按行翻页', () => {
  const note = readNote(VAULT, 'notes/alpha.md', index, { offset: 3, limit: 2 })
  assert.equal(note.lines.length, 2)
  assert.equal(note.lines[0].number, 3)
  assert.equal(note.truncated, true)
})
check('路径分隔符与 ./ 前缀都能容错', () =>
  assert.equal(readNote(VAULT, './notes\\deep\\gamma.md', index).path, 'notes/deep/gamma.md'))
check('读不存在的笔记时报错清楚', () =>
  assert.throws(() => readNote(VAULT, 'nothing-here.md', index), /no such note/))
check('越界路径被拒绝（路径穿越防护）', () => {
  assert.throws(() => readNote(VAULT, '../../secret.md', index), /vault-relative|escapes/)
  assert.throws(() => safeJoin(VAULT, 'a/../../b.md'), /vault-relative|escapes/)
  assert.throws(() => safeJoin(VAULT, ''), /required/)
})

// ── 5. search ────────────────────────────────────────────────────────────────

console.log('\n── 5. 全文检索 ─────────────────────────────────────────────')
check('检索命中正文并给出行号与片段', () => {
  const result = searchVault(VAULT, index, '入侵检测')
  assert.ok(result.total > 0)
  assert.ok(result.matches.some((match) => match.path === 'notes/alpha.md'))
  assert.ok(result.matches[0].lines.length > 0)
  assert.ok(result.matches[0].lines[0].lineNumber > 0)
})
check('多词为「全部命中」语义', () => {
  const both = searchVault(VAULT, index, '入侵检测 安全审计')
  const one = searchVault(VAULT, index, '入侵检测')
  assert.ok(both.total > 0)
  assert.ok(both.total <= one.total, 'AND semantics violated')
})
check('title/tag 命中优先于纯正文命中', () => {
  const result = searchVault(VAULT, index, '草稿')
  assert.ok(result.matches.length > 0)
  assert.equal(result.matches[0].path, 'inbox/draft.md')
})
check('domain 过滤生效', () => {
  const result = searchVault(VAULT, index, '安全', { domain: 'research', limit: 100 })
  assert.ok(result.total > 0)
  assert.ok(result.matches.every((match) => match.domain === 'research'))
})
check('folder 过滤生效', () =>
  assert.deepEqual(
    searchVault(VAULT, index, '安全', { folder: 'notes/deep', limit: 100 }).matches.map((m) => m.path),
    ['notes/deep/gamma.md'],
  ))
check('status 与 tag 过滤生效', () => {
  const drafts = searchVault(VAULT, index, '安全', { status: 'draft', limit: 100 })
  assert.ok(drafts.total > 0)
  assert.ok(drafts.matches.every((match) => match.status === 'draft'))
  assert.deepEqual(
    searchVault(VAULT, index, '安全', { tag: '运维', limit: 100 }).matches.map((m) => m.path),
    ['notes/deep/gamma.md'],
  )
})
check('limit 生效并标记截断', () => {
  const wide = searchVault(VAULT, index, '安全', { limit: 100 })
  const narrow = searchVault(VAULT, index, '安全', { limit: 2 })
  assert.ok(wide.total >= 3, `expected several matches, got ${wide.total}`)
  assert.equal(narrow.matches.length, 2)
  assert.equal(narrow.truncated, true)
  assert.equal(wide.truncated, false)
})
check('空 query 报错，无命中返回零结果而不是报错', () => {
  assert.throws(() => searchVault(VAULT, index, '   '), /at least one term/)
  assert.equal(searchVault(VAULT, index, 'zzz-nowhere-zzz').total, 0)
})
check('超长行以命中词为中心截断，并保留省略号', () => {
  const result = searchVault(VAULT, index, '基线')
  const hits = result.matches.flatMap((match) => match.lines)
  assert.ok(hits.length > 0, 'no hit on the long line')
  for (const hit of hits) {
    assert.ok(hit.line.length <= 162, `snippet too long: ${hit.line.length}`)
    assert.ok(hit.line.includes('基线'), 'the matched term should survive truncation')
  }
  assert.ok(hits.some((hit) => hit.line.includes('…')), 'a truncated snippet should carry an ellipsis')
})

// Regression: a match from a note with no frontmatter must carry `null`, not
// `undefined`, or the harness rejects the whole result with "value is not
// lossless JSON" (the runner re-checks this on every call below).
check('无 frontmatter 的笔记在结果里用 null 而非 undefined', () => {
  const result = searchVault(VAULT, index, '这一段')
  assert.equal(result.total, 1)
  assert.equal(result.matches[0].path, 'notes/no-frontmatter.md')
  assert.equal(result.matches[0].domain, null)
  assert.equal(result.matches[0].status, null)
  assertLossless('searchVault result', result)
})

// ── 6. write boundary ────────────────────────────────────────────────────────

console.log('\n── 6. 写入边界 ─────────────────────────────────────────────')
check('拒绝写入白名单之外的路径', () => {
  assert.throws(
    () => writeNote(VAULT, 'notes/alpha.md', 'ADDED', { allowPrefixes: ALLOW, mode: 'append' }),
    /allows agent writes only under/,
  )
  assert.equal(readFileSync(join(VAULT, 'notes/alpha.md'), 'utf8').includes('ADDED'), false)
})
check('未配置 writeAllow 时写入默认禁用', () => {
  assert.throws(() => writeNote(VAULT, 'inbox/new.md', 'x', { allowPrefixes: [] }), /writes are disabled/)
  assert.throws(() => writeNote(VAULT, 'inbox/new.md', 'x', {}), /writes are disabled/)
  assert.equal(existsSync(join(VAULT, 'inbox/new.md')), false)
})
check('拒绝非 .md 目标', () =>
  assert.throws(() => writeNote(VAULT, 'inbox/x.txt', 'x', { allowPrefixes: ALLOW }), /must end with \.md/))
check('拒绝穿越出库的写入路径', () =>
  assert.throws(() => writeNote(VAULT, 'inbox/../../evil.md', 'x', { allowPrefixes: ALLOW }), /vault-relative|escapes/))
check('拒绝路径前缀伪装（inbox-extra 不算命中）', () => {
  assert.throws(
    () => writeNote(VAULT, 'inbox-extra/x.md', 'x', { allowPrefixes: ALLOW }),
    /allows agent writes only under/,
  )
  assert.equal(existsSync(join(VAULT, 'inbox-extra')), false)
})
check('被拒的写入没有留下任何痕迹', () =>
  assert.ok(readFileSync(join(VAULT, 'notes/alpha.md'), 'utf8').startsWith('---\ntype: note')))

// ── 7. write behaviour ───────────────────────────────────────────────────────

console.log('\n── 7. 写入行为 ─────────────────────────────────────────────')
check('create 新建笔记并自动建目录', () => {
  const result = writeNote(VAULT, 'inbox/sub/新笔记.md', '# 新笔记\n正文\n', { allowPrefixes: ALLOW })
  assert.equal(result.created, true)
  assert.equal(result.mode, 'create')
  assert.ok(existsSync(join(VAULT, 'inbox/sub/新笔记.md')))
})
check('create 遇到已存在文件时报错', () =>
  assert.throws(() => writeNote(VAULT, 'inbox/sub/新笔记.md', 'x', { allowPrefixes: ALLOW }), /already exists/))
check('append 追加且以空行分隔', () => {
  const result = writeNote(VAULT, 'inbox/sub/新笔记.md', '追加段', { allowPrefixes: ALLOW, mode: 'append' })
  assert.equal(result.created, false)
  assert.ok(readFileSync(join(VAULT, 'inbox/sub/新笔记.md'), 'utf8').includes('正文\n\n追加段'))
})
check('overwrite 覆盖全文', () => {
  writeNote(VAULT, 'inbox/sub/新笔记.md', '全新内容', { allowPrefixes: ALLOW, mode: 'overwrite' })
  assert.equal(readFileSync(join(VAULT, 'inbox/sub/新笔记.md'), 'utf8'), '全新内容')
})
check('写入后用 readNote 能读回并解析', () => {
  writeNote(
    VAULT,
    'inbox/sub/带属性.md',
    ['---', 'type: note', 'domain: meta', 'tags: [a, b]', '---', '', '# 带属性', '', '正文 #行内标签', ''].join('\n'),
    { allowPrefixes: ALLOW },
  )
  const note = readNote(VAULT, 'inbox/sub/带属性.md', null)
  assert.equal(note.frontmatter.domain, 'meta')
  assert.deepEqual(note.frontmatter.tags, ['a', 'b'])
  assert.ok(note.tags.includes('行内标签'))
  assert.equal(note.title, '带属性')
})
check('normalizeRel 归一化', () => {
  assert.equal(normalizeRel('.\\a\\b.md'), 'a/b.md')
  assert.equal(normalizeRel('./a//b.md/'), 'a/b.md')
})

// ── 8. plugin assembly and tool calls ────────────────────────────────────────

console.log('\n── 8. 插件装配与工具调用 ───────────────────────────────────')

const EXPECTED_TOOLS = [
  'obsidian_list',
  'obsidian_read',
  'obsidian_search',
  'obsidian_status',
  'obsidian_sync',
  'obsidian_write',
]
const indexDir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-index-'))
const registered = []
applyPlugin(
  {
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
  },
  { vault: VAULT, indexDir, ignoreDirs: IGNORE, writeAllow: ALLOW },
)
const tool = (toolName) => registered.find((definition) => definition.name === toolName)
const run = makeRunner(tool)

await checkAsync('apply() 把 6 个工具注册进 ctx.tools，且没有重复名', () =>
  assert.deepEqual(
    registered.map((definition) => definition.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  ))
await checkAsync('每个工具都带 description / parameters / output.schema / render / execute', () => {
  for (const definition of registered) {
    assert.ok(definition.description?.length > 20, `${definition.name}: description`)
    assert.equal(definition.parameters?.type, 'object', `${definition.name}: parameters.type`)
    assert.equal(definition.output?.schema?.type, 'object', `${definition.name}: output.schema`)
    assert.equal(typeof definition.output.render, 'function', `${definition.name}: render`)
    assert.equal(typeof definition.execute, 'function', `${definition.name}: execute`)
  }
})
await checkAsync('写入前缀只出现在 obsidian_write 的描述里', () => {
  assert.ok(tool('obsidian_write').description.includes('inbox'), tool('obsidian_write').description)
  for (const definition of registered.filter((item) => item.name !== 'obsidian_write')) {
    assert.ok(!definition.description.includes('inbox'), `${definition.name} leaked the write prefix`)
  }
})
await checkAsync('挂载时自动落盘 INDEX.md 与 index.json（含第 7 节写入的笔记）', () => {
  assert.ok(existsSync(join(indexDir, 'INDEX.md')), 'INDEX.md missing')
  assert.ok(existsSync(join(indexDir, 'index.json')), 'index.json missing')
  const parsed = JSON.parse(readFileSync(join(indexDir, 'index.json'), 'utf8'))
  assert.equal(parsed.vaultPath, VAULT)
  assert.equal(parsed.stats.notes, 9)
})
await checkAsync('obsidian_status 报告已连接、索引不脏、写入范围正确', async () => {
  const { value, rendered } = await run('obsidian_status')
  assert.equal(value.connected, true)
  assert.equal(value.vaultPath, VAULT)
  assert.equal(value.index.stale, false)
  assert.deepEqual(value.writeAllow, ALLOW)
  assert.ok(Array.isArray(value.discovered))
  assert.ok(rendered.includes('已连接'), rendered)
  assert.ok(rendered.includes('AI 可写范围'), rendered)
})
await checkAsync('obsidian_list 过滤、分页与渲染', async () => {
  const filtered = await run('obsidian_list', { domain: 'research', limit: 10 })
  assert.ok(filtered.value.total > 0)
  assert.ok(filtered.value.notes.every((note) => note.domain === 'research'))
  assert.ok(filtered.rendered.includes('匹配'), filtered.rendered.slice(0, 120))

  const paged = await run('obsidian_list', { limit: 2, offset: 1 })
  assert.equal(paged.value.notes.length, 2)
  assert.equal(paged.value.offset, 1)

  const byTag = await run('obsidian_list', { tag: '#运维' })
  assert.deepEqual(byTag.value.notes.map((note) => note.path), ['notes/deep/gamma.md'])
})
await checkAsync('obsidian_read 返回带行号的正文与反向链接', async () => {
  const { value, rendered } = await run('obsidian_read', { path: 'notes/alpha.md', limit: 5 })
  assert.equal(value.lines.length, 5)
  assert.equal(value.lines[0].number, 1)
  assert.equal(value.backlinks.length, 3)
  assert.ok(rendered.includes('反向链接'), rendered)
})
await checkAsync('obsidian_read 缺 path 时报错', () =>
  assert.rejects(() => tool('obsidian_read').execute({}), /needs a non-empty "path"/))
await checkAsync('obsidian_search 命中并渲染行号片段', async () => {
  const { value, rendered } = await run('obsidian_search', { query: '入侵检测' })
  assert.ok(value.total > 0)
  assert.ok(rendered.includes('命中'), rendered)
  assert.ok(/\d+\s+\S/.test(rendered), 'no line-numbered snippet')
})
await checkAsync('obsidian_search 对无 frontmatter 的笔记返回 null', async () => {
  const { value } = await run('obsidian_search', { query: '这一段' })
  assert.equal(value.total, 1)
  assert.equal(value.matches[0].domain, null)
  assert.equal(value.matches[0].status, null)
})
await checkAsync('obsidian_search 缺 query 时报错', () =>
  assert.rejects(() => tool('obsidian_search').execute({}), /needs a non-empty "query"/))
await checkAsync('obsidian_sync 强制重建并回报写入路径', async () => {
  const { value, rendered } = await run('obsidian_sync')
  assert.deepEqual(value.written, [join(indexDir, 'INDEX.md'), join(indexDir, 'index.json')])
  assert.ok(value.notes > 0)
  assert.ok(rendered.includes('已同步'), rendered)
})
await checkAsync('obsidian_write 在允许范围内创建笔记并自动补 frontmatter', async () => {
  const { value, rendered } = await run('obsidian_write', {
    path: 'inbox/sub/工具写入.md',
    content: '# 工具写入\n\n正文。\n',
    frontmatter: { type: 'note', domain: 'meta', topic: '自检', status: 'draft', tags: ['自检'], created: '2026-01-01' },
  })
  assert.equal(value.created, true)
  assert.ok(rendered.includes('已创建'), rendered)
  assert.deepEqual(value.allowPrefixes, ALLOW)
  const text = readFileSync(join(VAULT, 'inbox/sub/工具写入.md'), 'utf8')
  assert.ok(text.startsWith('---\n'), 'frontmatter not prepended')
  assert.ok(text.includes('domain: meta'))
  assert.ok(text.includes('# 工具写入'))
})
await checkAsync('obsidian_write 可读回，并拒绝白名单之外的路径', async () => {
  const read = await run('obsidian_read', { path: 'inbox/sub/工具写入.md' })
  assert.equal(read.value.frontmatter.domain, 'meta')
  await assert.rejects(
    () => tool('obsidian_write').execute({ path: 'notes/alpha.md', content: 'ADDED', mode: 'append' }),
    /allows agent writes only under/,
  )
  assert.equal(readFileSync(join(VAULT, 'notes/alpha.md'), 'utf8').includes('ADDED'), false)
})
await checkAsync('工作区索引只含元数据，没有正文副本', () => {
  const markdown = readFileSync(join(indexDir, 'INDEX.md'), 'utf8')
  const parsed = JSON.parse(readFileSync(join(indexDir, 'index.json'), 'utf8'))
  for (const note of parsed.notes) {
    for (const field of ['content', 'body', 'text', 'raw']) {
      assert.ok(!(field in note), `${note.path} carries a "${field}" body field`)
    }
    assert.equal(typeof note.lines, 'number', `${note.path}.lines should be a count, not body lines`)
    assertLossless(`index entry ${note.path}`, note)
  }
  assert.ok(!markdown.includes('正文提到入侵检测与安全审计的配合'), 'a note body leaked into the workspace index')
})

// ── teardown ─────────────────────────────────────────────────────────────────

rmSync(indexDir, { recursive: true, force: true })
check('清理：fixture 库被完整删除，没有残留', () => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
  assert.equal(existsSync(VAULT), false)
})

console.log('\n──────────────────────────────────────────────────────────')
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言组\n`)
} else {
  console.log(`通过 ${passed} 组，失败 ${failures.length} 组：`)
  for (const failure of failures) console.log(`\n✗ ${failure.label}\n${failure.error?.stack}`)
  process.exitCode = 1
}
