import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Material, PageIssue, Source } from './syllora-domain.ts'
import type { FileCandidate } from './syllora-project-types.ts'
export type { FileCandidate } from './syllora-project-types.ts'

export const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export function stableId(value:string) { const h=sha(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}` }
export const SOURCE_LIMIT = 20 * 1024 * 1024
/** Preserve physical page numbers, including pages the parser did not return. */
export function pdfPageIssues(result:{total:number;pages:Array<{num:number;text:string}>}):PageIssue[] {
  if(!Number.isInteger(result.total)||result.total<1||result.pages.some(p=>!Number.isInteger(p.num)||p.num<1||p.num>result.total))throw new Error('PDF 解析返回了无效页码')
  const seen=new Map(result.pages.map(p=>[p.num,p.text]))
  return Array.from({length:result.total},(_,i)=>i+1).flatMap<PageIssue>(num=>!seen.has(num)?[{num,reason:'unextracted-text'}]:!seen.get(num)!.trim()?[{num,reason:'blank-page'}]:[])
}
// `notes` 是本应用管理的笔记目录（{课程根}/notes/）：用户自己的笔记不作为课程资料候选，
// 否则每写一篇笔记都会出现在资料清单里，并可能被当作生成依据发送给模型。
const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'target', 'tmp', '__pycache__', 'notes'])

export async function atomicJson(path: string, value: unknown) {
  return atomicText(path, JSON.stringify(value, null, 2))
}
export async function atomicText(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  const file = await open(tmp, 'wx', 0o600)
  try {
    try { await file.writeFile(text); await file.sync() } finally { await file.close() }
    // Windows readers/virus scanners may briefly deny replacement; never delete the durable target.
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, path); break }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['EPERM','EACCES','EBUSY'].includes(code ?? '') || attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt))
      }
    }
  } catch (error) { await rm(tmp, { force:true }).catch(() => undefined); throw error }
}
export async function jsonFile<T>(path: string): Promise<T | null> {
  try { if (!(await lstat(path)).isFile()) throw new Error('状态文件不能是目录或文件链接'); return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export async function within(root: string, name: string): Promise<string> {
  if (isAbsolute(name) || name.split(/[\\/]/).some(p => p === '..' || p === '.syllora')) throw new Error('资料路径必须位于课程目录内')
  const base = await realpath(root), target = await realpath(resolve(base, name))
  const rel = relative(base, target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('资料路径越出课程目录')
  return target
}
export async function stateDirectory(root: string) {
  const base = await realpath(root), path = join(base, '.syllora')
  await mkdir(path, { recursive: true })
  if (await realpath(path) !== path) throw new Error('.syllora 必须是课程内的普通目录，不能是目录链接')
  return path
}
export async function managedDirectory(base: string, name: string) {
  let path=await realpath(base)
  for(const part of name.split('/')) {
    if(!part||part==='.'||part==='..'||part.includes('\\'))throw new Error('无效的产物目录')
    path=join(path,part);await mkdir(path,{recursive:true})
    if(await realpath(path)!==path)throw new Error('应用产物目录不能是目录链接')
  }
  return path
}
export async function removeProducts(root: string, names: string[]) {
  const base=await stateDirectory(root)
  for(const name of names) {
    if(!['course.json','revisions','.staging'].includes(name))throw new Error('禁止清理非 Syllora 产物')
    const path=join(base,name), info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e})
    if(!info)continue
    if(info.isSymbolicLink()||await realpath(path)!==path)throw new Error('产物目录是链接，清理已停止')
    const rel=relative(base,path)
    if(isAbsolute(rel)||rel.startsWith('..')||!rel)throw new Error('清理路径越界')
    await rm(path,{recursive:info.isDirectory(),force:true})
  }
}
export async function scanFiles(root: string, materials: Material[]): Promise<FileCandidate[]> {
  const found: FileCandidate[] = []
  /**
   * Fingerprints already established for unchanged files. Re-hashing the whole folder on every scan costs one
   * full read per file even when nothing changed; `mtimeMs + size` is the cheap identity, and every reader that
   * trusts a fingerprint still re-reads the bytes (`initializeFolder` verifies, then verifies again at the end),
   * so a stale fingerprint surfaces as a "资料发生变化" failure rather than as silent wrong content.
   */
  const known = new Map<string, Material>()
  for (const material of materials) {
    const path = material.path
    // typeof 而不是 falsy：mtimeMs 恰为 0（1970-01-01）是合法文件，不能被排除在复用之外。
    if (!path || material.status === 'deleted' || typeof material.fingerprint !== 'string' || !material.fingerprint || typeof material.size !== 'number' || typeof material.mtimeMs !== 'number') continue
    if (!known.has(path)) known.set(path, material)
  }
  async function walk(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$') || excluded.has(entry.name) || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name), name = relative(root, path).split(sep).join('/')
      if (entry.isDirectory()) { await walk(path); continue }
      if (!entry.isFile()) continue
      const info = await stat(path), size = info.size, mtimeMs = info.mtimeMs, supported = ['.pdf', '.md', '.txt'].includes(extname(entry.name).toLowerCase())
      let status: FileCandidate['status'] = !supported ? 'unsupported' : size > SOURCE_LIMIT ? 'too-large' : 'ready'
      let fingerprint: string | null = null
      if (status === 'ready') {
        const previous = known.get(name)
        if (previous && previous.size === size && previous.mtimeMs === info.mtimeMs) fingerprint = previous.fingerprint!
        else try { fingerprint = sha(await readFile(path)) } catch { status = 'unreadable' }
      }
      const old = materials.find(m => m.path === name && m.status !== 'deleted')
      found.push({ path: name, size, mtimeMs, fingerprint, status, change: !old ? 'added' : old.fingerprint === fingerprint ? 'unchanged' : 'changed', reason: status === 'ready' ? '' : status === 'too-large' ? '单文件超过 20 MiB' : status === 'unreadable' ? '文件无法读取' : '本轮仅支持文本 PDF、MD/TXT' })
    }
  }
  await walk(root)
  return found
}

interface Block { text: string; start: number; end: number; section: string; context: string; kind: string; anchor: string }
/**
 * A numbered line is only a chapter when it reads like one. PDF extraction wraps long formulas onto their own
 * lines, and those wrapped fragments start with a number too (`2 = ℎ𝑖 ⋅ (𝑧𝑖 − 𝑧𝑛𝑎)2。…`, `12 + ℎ𝑖(𝑧𝑖 − 𝑧𝑛𝑎)2]`).
 * Treating them as chapters invents a section per formula, and since chapters are the model-call boundary that
 * costs one extra call each. CJK text after the number is the cheap discriminator: real headings carry a title,
 * the wrapped formulas carry an operator, a digit, or a unit instead.
 */
const CHAPTER_TITLE = /[\u3400-\u9fff\uf900-\ufaff]/
function looksLikeChapter(numbered: RegExpExecArray): boolean {
  const title = numbered[2]!.trim()
  return CHAPTER_TITLE.test(title) && !/^[=+\-−–—×÷*/^_<>≤≥≈%‰°]/.test(title)
}
/**
 * Structure-first scanner: fenced code and tables survive blank lines; raw offsets never include added context.
 * `fallback` groups fragments that belong to one document: a PDF page anchor differs per page, so using it as
 * the section fallback would make every page its own chapter and turn one chapter per model call into one call
 * per page. When that fallback is accepted it is also the section shown to the learner, so the display keeps the
 * document identity; the block anchor stays page-accurate.
 */
function blocks(text: string, label: string, fallback: string): Block[] {
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []
  const result: Block[] = [], headings: string[] = []
  let offset = 0, i = 0
  while (i < lines.length) {
    const line = lines[i]!, start = offset, startLine=i+1
    if (!line.trim()) { offset += line.length; i++; continue }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim())
    const numbered = /^\s*\d+[.)]\s/.test(line) ? null : /^(第[一二三四五六七八九十百\d]+[章节]|\d+(?:\.\d+)*[、.\s])\s*(.{1,70})$/.exec(line.trim())
    const chapter = numbered && looksLikeChapter(numbered) ? numbered : null
    if (heading || chapter) {
      const level = heading ? heading[1]!.length : 1
      headings.splice(level - 1); headings[level - 1] = heading ? heading[2]! : line.trim()
    }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    const kind = fence ? 'code' : /^\s*\|/.test(line) ? 'table' : /^\s*(?:[-*+] |\d+[.)] )/.test(line) ? 'list' : heading || chapter ? 'heading' : 'paragraph'
    let body = line; offset += line.length; i++
    if (fence) {
      while (i < lines.length) { const next = lines[i++]!; body += next; offset += next.length; if (next.trim().startsWith(fence[1]![0]!.repeat(fence[1]!.length))) break }
    } else if (kind !== 'heading') {
      while (i < lines.length) {
        const next = lines[i]!
        if (!next.trim() || /^\s*(?:#{1,6}\s|`{3,}|~{3,})/.test(next) || (kind === 'table' && !/^\s*\|/.test(next))) break
        if (kind !== 'table' && /^\s*\|/.test(next)) break
        if (kind === 'paragraph' && /^\s*(?:[-*+] |\d+[.)] )/.test(next)) break
        if (!/^\s*\d+[.)]\s/.test(next) && /^\d+(?:\.\d+)*[、.\s]\s*.{1,70}$/.test(next.trim())) break
        if (/^(第[一二三四五六七八九十百\d]+[章节])/.test(next.trim())) break
        body += next; offset += next.length; i++
      }
    }
    result.push({ text: body, start, end: offset, section: headings.filter(Boolean).join(' / ') || fallback, context: headings.filter(Boolean).join(' > '), kind, anchor: `${label} · 行 ${startLine}–${i}` })
  }
  return result
}
function pieces(block: Block): Block[] {
  if ([...block.text].length <= 2400) return [block]
  const result: Block[] = []
  let cursor = 0
  while (cursor < block.text.length) {
    const window = [...block.text.slice(cursor)].slice(0, 2400).join('')
    let cut = window.length
    if (cursor + cut < block.text.length) {
      const preferred = block.kind === 'code' || block.kind === 'table' || block.kind === 'list' ? /\n/g : /[。！？；\n.!?;]/g
      for (const match of window.matchAll(preferred)) if (match.index! >= window.length / 2) cut = match.index! + match[0].length
    }
    const raw = block.text.slice(cursor, cursor + cut)
    const tableHeader = block.kind === 'table' ? block.text.split('\n').slice(0,2).join('\n') : ''
    result.push({ ...block, text: raw, start: block.start + cursor, end: block.start + cursor + cut, context: [block.context, cursor ? '续段' : '', cursor ? tableHeader : ''].filter(Boolean).join('\n') })
    cursor += cut
  }
  return result
}
export function structuredSources(materialId: string, version: string, parts: Array<{ text: string; anchor: string; name?: string }>): Source[] {
  const groups: Block[] = []
  for (const part of parts) {
    const fallback = part.name ?? part.anchor
    for (const block of blocks(part.text, part.anchor, fallback).flatMap(pieces)) {
      const prev = groups.at(-1)
      // 合并只在同一份文档的同一 part 内进行：不能只靠 anchor 前缀判断，否则两份同 basename、同页号的
      // 资料（part.anchor 都是「第 1 页」）会被并成一条，`part.text.slice` 会用后一份的正文覆盖前一份。
      if (prev && prev.section === block.section && prev.anchor.startsWith(`${part.anchor} · `) && prev.kind === 'paragraph' && block.kind === 'paragraph' && [...part.text.slice(prev.start,block.end)].length <= 1800) {
        // Only merge contiguous raw ranges; skipped blank lines remain in the original text.
        prev.text = part.text.slice(prev.start, block.end); prev.end = block.end
        const lastLine=part.text.slice(0,block.end).split('\n').length-(part.text[block.end-1]==='\n'?1:0)
        prev.anchor=`${part.anchor} · 行 ${part.text.slice(0,prev.start).split('\n').length}–${lastLine}`
      } else groups.push(block)
    }
  }
  const sources: Source[] = groups.map(b => ({ id: sha(`${materialId}:${b.anchor}:${b.section}:${b.start}:${b.end}:${b.text}`), materialId, version, anchor: `${b.anchor} · 字符 ${b.start + 1}–${b.end}`, text: b.text, section: b.section, context: b.context, kind: b.kind, start: b.start, end: b.end }))
  sources.forEach((s,i) => { if (i) s.previousId = sources[i-1]!.id; if (i+1 < sources.length) s.nextId = sources[i+1]!.id })
  return sources
}
export function selectContext(sources: Source[], query: string, limit = 22000): Source[] {
  const text = query.toLowerCase(), terms = new Set(text.match(/[\p{L}\p{N}]+/gu) ?? [])
  for (const segment of text.match(/[\p{Script=Han}]+/gu) ?? []) for (let i=0;i<segment.length-1;i++) terms.add(segment.slice(i,i+2))
  const score = (s: Source) => [...terms].reduce((n,t) => n + (s.text.toLowerCase().includes(t) ? t.length : 0) + ((s.context ?? '').toLowerCase().includes(t) ? t.length*2 : 0),0)
  const ranked = [...sources].sort((a,b) => score(b)-score(a)), selected: Source[] = [], seen = new Set<string>()
  let size = 0
  const represented=new Set<string>()
  // Reserve one relevant fragment per material before filling with more fragments.
  for(const source of ranked) {
    const length=JSON.stringify(source).length
    if(represented.has(source.materialId)||size+length>limit)continue
    selected.push(source);seen.add(source.id);represented.add(source.materialId);size+=length
  }
  for (const s of ranked) {
    for (const candidate of [s, sources.find(v => v.id === s.previousId), sources.find(v => v.id === s.nextId)]) {
      if (!candidate || seen.has(candidate.id)) continue
      const length = JSON.stringify(candidate).length
      if (size + length > limit) continue
      selected.push(candidate); seen.add(candidate.id); size += length
    }
  }
  return selected
}
