/**
 * Chat host package: config resolution, DeepSeek adapter wiring, and the
 * session service behind the RPC layer.
 * @module @syllora/chat-service
 */

export { loadChatConfig, providerFacts } from './config.ts'
export { setSharedConfigRoot } from './shared-root.ts'
export { verifyCredentialsReadable } from './secret-box.ts'
export { AGENT_SKILLS, AGENT_SKILL_IDS, agentSkillPrompt } from './skills.ts'
export type { AgentSkillPayload } from './skills.ts'
export { SylloraService, SylloraError } from './syllora.ts'
export { SylloraProjects, migrateSharedSettings } from './syllora-projects.ts'
export type { ResolvedChatConfig } from './config.ts'
export {
  settingsPayload,
  providerCatalog,
  discoverModels,
  saveProvider,
  deleteProvider,
  activateProvider,
  setCredential,
  updateSettings,
  testConnection,
  reorderProviders,
  exportProviders,
  importProviders,
  deriveKeyRef,
  ProviderExistsError,
} from './settings.ts'
export type { SettingsPayload, ProviderPayload, ProviderModelPayload, CatalogEntry, ConnectionTestResult, ConnectionFailureKind, ProviderExportEntry, ProviderExportPayload } from './settings.ts'
export { createDeepSeekToolClient } from './adapter.ts'
export {
  listSessions,
  searchSessions,
  createSession,
  renameSession,
  forkSession,
  archiveSession,
  reorderSession,
  restoreSession,
  sessionModels,
  selectSessionModel,
  sessionEvents,
  sessionProjection,
  createLearningAgent,
  LearningAgentService,
  chatStream,
  agentEventToFrame,
  fileContextOf,
} from './service.ts'
export type { SessionSummaryView, SessionSearchView, RestoredSessionView, SessionModelDirectory, SessionModelSelection, SessionModelGroup, LearningAgentOptions, AgentRuntimeConfig, SessionEventView, MaintenanceJobView } from './service.ts'
export { createCourseService, CourseNotFoundError, JobManager, resolveCourseDir } from './course.ts'
export type { CourseService, JobView } from './course.ts'
export { streamReadingAsk, READING_ASK_MAX_CHARS } from './reading-ask.ts'
export type { ReadingAskInput, ReadingAskChunk, ReadingAskClientFactory } from './reading-ask.ts'
