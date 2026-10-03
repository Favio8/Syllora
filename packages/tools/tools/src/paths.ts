import { workspaceStateDirOf } from './runtime-paths.ts'
/**
 * Course path facts for the tools layer: the source-root canon (`.source-root.json`
 * binding for in-place courses, the project root otherwise) and the in-place
 * exclusion set. Ported from Python `workspace.py`; project-folder-as-course
 * layout makes every course "in place".
 * @module @syllora/tools/src/paths
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolRejected } from './result.ts'

export const SOURCE_ROOT_BINDING_NAME = '.source-root.json'

/** Courses must not scan these as study material (Python parity, plus the
 *  project-folder-as-course state directories). */
export const INPLACE_SOURCE_EXCLUDED_DIRS = new Set([
  '.git',
  '.syllora',
  '.studyclaw',
  '.syllora-home',
  '.syllora-data',
  'courses',
  'node_modules',
  '__pycache__',
  '.next',
  '.venv',
  'venv',
  'tasks',
  'history',
])

/** State file names skipped by material scans (value mirrors
 *  `@syllora/course-builder`'s COURSE_STATE_FILES; kept local to avoid a
 *  dependency cycle — tools ↔ builder). */
export const SOURCE_EXCLUDED_FILES = new Set([
  'syllabus.json',
  'progress.md',
  'notes.md',
  '.checksums',
  '.source-root.json',
])

/**
 * Windows 8.3 短名别名形态（如 `.syllora` → `SYLLOR~1`）：NTFS 为长名自动
 * 生成短名，Node 的 realpath **不展开**短名，字符串 containment 会放行——
 * 模型可用 `SYLLOR~1/progress.md` 之类引用绕过点目录/状态目录排除，直读课程
 * 状态文件（题池含答案键、progress 等）。只拒绝以 `~数字` 结尾的段：合法名
 * `backup~1.txt`（扩展名在后）不受影响；极少数以 `~数字` 结尾的真备份名
 * （`notes~2`）被误伤，属可接受的 fail-closed（安全边界不猜意图）。
 */
export function isEightDotThreeSegment(segment: string): boolean {
  return /^[^./\\]+~\d+$/i.test(segment)
}

/**
 * The course's actual material root: the `.source-root.json` binding for
 * in-place courses, the project root otherwise.
 * @param courseDir - Course (project root) directory.
 * @returns the resolved material root.
 */
export async function courseSourceRoot(courseDir: string): Promise<string> {
  const binding = join(courseDir, SOURCE_ROOT_BINDING_NAME)
  try {
    const data = JSON.parse(await readFile(binding, 'utf8')) as { path?: unknown }
    const raw = data?.path
    if (typeof raw === 'string' && raw !== '') {
      const target = resolve(courseDir, raw)
      // T-2：绑定目标此前零校验——被污染的仓库植入指向工作区外绝对路径的
      // `.source-root.json`，read_source/search_sources 就会以任意目录为资料
      // 根越界读全部 .md/.txt。限定绑定必须在 courseDir 内，否则忽略该绑定
      // 回退规范的项目根（不抛错：宿主还有其他调用方依赖宽松语义）。
      const base = resolve(courseDir)
      const prefix = base.endsWith(sep) ? base : base + sep
      if (target === base || target.startsWith(prefix)) return target
    }
  } catch {
    // No binding / unreadable: fall through to the canonical project root.
  }
  return courseDir
}

/**
 * Whether the course uses its original project directory as the material root.
 * CR-22：`.source-root.json` 全仓库没有任何生产代码写入，此判定恒 false，
 * 使 `INPLACE_SOURCE_EXCLUDED_DIRS` 成为死代码——默认布局下可读
 * `courses/<其他课程>/notes.md`、`tasks/` 等，`search_sources` 还会扫
 * node_modules。排除集是与布局无关的（都为「不该被当学习资料」的目录），
 * 不再以该标志为生效条件；本函数保留给仍依赖 in-place 语义的调用方。
 */
export async function isInplaceCourse(courseDir: string): Promise<boolean> {
  return (await stat(join(courseDir, SOURCE_ROOT_BINDING_NAME)).catch(() => null))?.isFile() ?? false
}

/**
 * CR-22：参与资料扫描时的排除目录集。排除项与课程布局无关，直接生效；
 * `inPlace` 形参保留以兼容既有调用方（当前不再改变结果）。
 */
export function sourceExcludedDirs(_inPlace?: boolean): ReadonlySet<string> {
  return INPLACE_SOURCE_EXCLUDED_DIRS
}

/**
 * 状态文件路径（v2 布局优先）：新布局下 syllabus.json / progress.md 等
 * 收在 `<root>/.syllora/` 内；仅当 v2 文件不存在而旧布局根目录文件存在时
 * 才回退到根目录，保证历史工作区仍可读。
 */
export async function resolveStateFile(courseDir: string, name: string): Promise<string> {
  const v2 = join(workspaceStateDirOf(courseDir), name)
  if ((await stat(v2).catch(() => null))?.isFile()) return v2
  return join(courseDir, name)
}

/**
 * Resolve a model-supplied relative path safely inside the source root:
 * absolute paths, `..`, hidden segments, and excluded dirs are rejected.
 * @param courseDir - Course directory.
 * @param ref - Relative path in any spelling.
 * @returns the resolved absolute path.
 */
export async function resolveSourceRef(courseDir: string, ref: string): Promise<string> {
  const root = resolve(await courseSourceRoot(courseDir))
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ToolRejected('课程资料根目录不存在（先运行 syllora build）')
  }
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new ToolRejected('path 不能为空')
  }
  const normalized = ref.trim().replaceAll('\\', '/')
  if (/^([a-zA-Z]:)?\//.test(normalized)) {
    throw new ToolRejected('path 必须是课程资料根目录下的相对路径')
  }
  const parts = normalized.split('/').filter(part => part !== '')
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    throw new ToolRejected(`非法的 path: ${ref}`)
  }
  // T-1：8.3 短名别名（SYLLOR~1）不展开且字符串 containment 放行——拒绝以
  // `~数字` 结尾的段，堵住经短名引用 `.syllora` 等被排除目录的绕过。
  if (parts.some(isEightDotThreeSegment)) {
    throw new ToolRejected('路径段疑似 Windows 8.3 短名别名（如 SYLLOR~1），已拒绝')
  }
  // CR-22：排除集直接生效（详见 sourceExcludedDirs 的注释）。
  const excluded: ReadonlySet<string> = sourceExcludedDirs()
  if (parts.some(part => part.startsWith('.') || excluded.has(part))) {
    throw new ToolRejected('不允许访问隐藏文件/目录或课程内部状态目录')
  }
  const target = resolve(root, ...parts)
  // 前缀必须用平台分隔符（sep）：此前硬编码 '\\'，Linux/macOS 上 resolve 产物
  // 以 '/' 分隔，前缀永不匹配 → 所有相对路径读取被误拒（CI Linux 两个红测试
  // 的根因；Windows 上恰好通过故本机未暴露）。resolve 已产出规范绝对路径，
  // 与 static-host.ts 的 `root + sep` 同一containment 惯例。
  const prefix = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(prefix)) {
    throw new ToolRejected('path 超出课程资料根目录')
  }
  // CR-21：词法 containment 不解析符号链接——资料根里植入指向外部的链接（或
  // 中间目录 junction）+ 客户端携带该 ref，即可把外部文件读进 LLM 上下文
  // （read_source 与 fileContextOf 都在出口补了 realpath 复核；这里再收一道口，
  // 让所有 resolveSourceRef 的调用方都拿到已解析的路径）。目标不存在时按原样
  // 返回：写侧/新建路径的语义不受影响，由调用方按需处理。
  const realRoot = await realpath(root).catch(() => root)
  const realTarget = await realpath(target).catch(() => null)
  if (realTarget === null) return target
  if (realTarget !== realRoot && !isWithinPath(realRoot, realTarget)) {
    throw new ToolRejected('path 不能通过符号链接越界')
  }
  return realTarget
}

/** realpath 产物之间的包含判定（异盘相对产物为绝对形态，显式排除）。 */
function isWithinPath(root: string, target: string): boolean {
  const relPath = relative(root, target)
  return relPath !== '' && !isAbsolute(relPath) && relPath !== '..' && !relPath.startsWith('..' + sep)
}
