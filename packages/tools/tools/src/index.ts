/**
 * Default registry assembly: all 18 specs registered with file, interactive,
 * and host-injected learning-action handlers (13 ported from Python
 * `agent_tools.py` plus 5 Syllora course-snapshot reads).
 * @module @syllora/tools
 */

import {
  handlerAskUserQuestion,
  handlerCreateCard,
  handlerEvaluateAnswer,
  handlerGenerateDynamicCard,
  handlerGetCourseState,
  handlerGetMemory,
  handlerGetMistakes,
  handlerGetProgressReport,
  handlerGetStudyPlan,
  handlerGetTaskPool,
  handlerReadMaterial,
  handlerReadNotes,
  handlerReadSource,
  handlerRunQuiz,
  handlerRunReview,
  handlerSearchSources,
  handlerSyncSources,
  handlerWriteNote,
  handlerReadFile,
  handlerSearchFiles,
  handlerWriteFile,
  handlerRunCommand,
  handlerFetchUrl,
  handlerSearchWeb,
  handlerPlan,
  handlerTodo,
  handlerSpawnAgent,
  handlerLsp,
  type ToolContext,
} from './handlers.ts'
import { ToolRegistry, ToolRuntime } from './registry.ts'
import { buildDefaultSpecs, buildGenericSpecs } from './specs.ts'

export { ToolRegistry, ToolRuntime, modeToolNames, MODE_TOOL_SETS } from './registry.ts'
export type { ToolBatchCall, ToolBatchResult, ToolRuntimeExecution, ToolRuntimeMiddleware } from './registry.ts'
export { buildDefaultSpecs, buildGenericSpecs, LOOP_LIMIT_NAME, MAX_PARALLEL_TOOL_CALLS } from './specs.ts'
export type { ToolSpec, ToolPolicy, ToolExecution, ToolRenderIntent } from './specs.ts'
export { ToolError, ToolRejected, ToolResult } from './result.ts'
export type { ToolStatus } from './result.ts'
export type { ToolContext } from './handlers.ts'
export type { ToolActions, ToolActionContext, ToolHandlerResult, ToolProviders } from './handlers.ts'
export { courseSourceRoot, isInplaceCourse, resolveSourceRef, sourceExcludedDirs, INPLACE_SOURCE_EXCLUDED_DIRS } from './paths.ts'
export { withCourseLock, parseProgressTable } from './handlers.ts'
export { workspaceStateDirOf, sylloraHome, migrateLegacyHome } from './runtime-paths.ts'

/** Assemble the default registry over one course. */
export function defaultToolRegistry(courseDir: string, workspaceRoot: string): ToolRegistry {
  const registry = new ToolRuntime(courseDir, workspaceRoot)
  for (const spec of buildDefaultSpecs()) {
    let handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<[string, Record<string, unknown>]>
    switch (spec.name) {
      case 'read_source': handler = handlerReadSource; break
      case 'search_sources': handler = handlerSearchSources; break
      case 'get_course_state': handler = handlerGetCourseState; break
      case 'get_memory': handler = handlerGetMemory; break
      case 'get_task_pool': handler = handlerGetTaskPool; break
      case 'create_card': handler = handlerCreateCard; break
      case 'generate_dynamic_card': handler = handlerGenerateDynamicCard; break
      case 'run_review': handler = handlerRunReview; break
      case 'run_quiz': handler = handlerRunQuiz; break
      case 'evaluate_answer': handler = handlerEvaluateAnswer; break
      case 'sync_sources': handler = handlerSyncSources; break
      case 'write_note': handler = handlerWriteNote; break
      case 'ask_user_question': handler = handlerAskUserQuestion; break
      case 'read_notes': handler = handlerReadNotes; break
      case 'read_material': handler = handlerReadMaterial; break
      case 'get_study_plan': handler = handlerGetStudyPlan; break
      case 'get_mistakes': handler = handlerGetMistakes; break
      case 'get_progress_report': handler = handlerGetProgressReport; break
      default: throw new Error(`未知默认工具: ${spec.name}`)
    }
    registry.register(spec, handler)
  }
  return registry
}

/** Assemble the generic DSH-style filesystem preset. */
export function genericToolRegistry(courseDir: string, workspaceRoot: string): ToolRegistry {
  const registry = new ToolRuntime(courseDir, workspaceRoot)
  const handlers = [handlerReadFile, handlerSearchFiles, handlerWriteFile, handlerRunCommand, handlerFetchUrl, handlerSearchWeb, handlerPlan, handlerTodo, handlerSpawnAgent, handlerLsp]
  for (const [index, handler] of handlers.entries()) registry.register(buildGenericSpecs()[index]!, handler)
  return registry
}

/** Assemble learning and generic tools in one Agent-facing registry. */
export function agentToolRegistry(courseDir: string, workspaceRoot: string): ToolRegistry {
  const registry = defaultToolRegistry(courseDir, workspaceRoot)
  const genericHandlers = [handlerReadFile, handlerSearchFiles, handlerWriteFile, handlerRunCommand, handlerFetchUrl, handlerSearchWeb, handlerPlan, handlerTodo, handlerSpawnAgent, handlerLsp]
  for (const [index, handler] of genericHandlers.entries()) {
    registry.register(buildGenericSpecs()[index]!, handler)
  }
  return registry
}
