/**
 * Chat host package: config resolution, DeepSeek adapter wiring, and the
 * session service behind the RPC layer.
 * @module @syllora/chat-service
 */

export { loadChatConfig, providerFacts, resolveCloudConfig } from './config.ts'
export { setSharedConfigRoot } from './shared-root.ts'
export { verifyCredentialsReadable } from './secret-box.ts'
export { AGENT_SKILLS, AGENT_SKILL_IDS, agentSkillPrompt } from './skills.ts'
export type { AgentSkillPayload } from './skills.ts'
export { SylloraService, SylloraError } from './syllora.ts'
export { DocMindClient, DocMindError, DOCMIND_ENDPOINT } from './docmind.ts'
export { docMindExtract, localExtract, pagesFromLayouts, documentOutline, type ExtractInput, type ExtractResult, type DocMindLike } from './syllora-extract.ts'
export type { ClassroomJobState } from './syllora.ts'
export { SylloraProjects, migrateSharedSettings } from './syllora-projects.ts'
export type { ResolvedChatConfig } from './config.ts'
export {
  resolveDocMindCredential,
  docmindConfigPayload,
  setDocMindCredential,
  cloudConfigPayload,
  setCloudConfig,
  CLOUD_ACCESS_CODE_REF,
  CLOUD_MODEL_API_KEY_REF,
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
export type { SettingsPayload, ProviderPayload, ProviderModelPayload, CatalogEntry, ConnectionTestResult, ConnectionFailureKind, ProviderExportEntry, ProviderExportPayload, CloudSettingsPayload } from './settings.ts'
export { ClassroomCloud, ClassroomStore, ClassroomAttachments, ClassroomInputError, classroomFailure, classroomGenerateSchema, classroomJobSchema, classroomGetSchema, classroomListSchema, classroomProgressSchema, classroomRolesBrief, classroomIdSchema, classroomMaterialMarkdown, sceneTypeCounts, CLOUD_ATTACHMENT_COUNT } from './syllora-classroom.ts'
export type { ClassroomMeta, ClassroomProgress, StagedAttachment } from './syllora-classroom.ts'
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
