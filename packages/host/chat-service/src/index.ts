/**
 * Chat host package: config resolution, DeepSeek adapter wiring, and the
 * session service behind the RPC layer.
 * @module @syllora/chat-service
 */

export { loadChatConfig, providerFacts } from './config.ts'
export { setSharedConfigRoot } from './shared-root.ts'
export { SylloraService, SylloraError } from './syllora.ts'
export { SylloraProjects, migrateSharedSettings } from './syllora-projects.ts'
export type { ResolvedChatConfig } from './config.ts'
export {
  docmindConfigPayload,
  setDocMindCredential,
  settingsPayload,
  providerCatalog,
  discoverModels,
  saveProvider,
  deleteProvider,
  activateProvider,
  setCredential,
  updateSettings,
  deriveKeyRef,
  ProviderExistsError,
} from './settings.ts'
export type { SettingsPayload, ProviderPayload, ProviderModelPayload, CatalogEntry } from './settings.ts'
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
export { createCourseService, CourseNotFoundError, JobManager } from './course.ts'
export type { CourseService, JobView } from './course.ts'
