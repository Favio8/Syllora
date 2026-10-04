import type { LearningSession } from '../../../../packages/host/chat-service/src/syllora-sessions'
import type { sessionMetrics } from '../../../../packages/host/chat-service/src/syllora-sessions'
import type { Course, Question, Evidence, Material, JobCoverage, NextAction, PlanDiff, DetailedPlanDiff, SourceRef } from '../../../../packages/host/chat-service/src/syllora-domain'
export type { Task, Source, Material, PageIssue, MaterialFile } from '../../../../packages/host/chat-service/src/syllora-domain'
export type CourseView = Omit<Course, 'questions'|'materials'> & {
  // state 里的来源只带定位信息（正文按 id 取），整本教材不再把全文塞进每次轮询。
  materials:Array<Omit<Material,'sources'|'history'>&{sources:SourceRef[];history?:SourceRef[];previewUrl?:string|null}>;
  questions: Array<Omit<Question,'answer'|'explanation'|'quote'> & Partial<Pick<Question,'answer'|'explanation'|'quote'>>>;
  evidence: Record<string,Evidence>;
  blockedPointIds: string[];
  activeSession?:LearningSession|null;
  metrics?:ReturnType<typeof sessionMetrics>;
  next: NextAction;
  draftDiff: PlanDiff | null;
  detailedDraftDiff: DetailedPlanDiff | null;
  progress:{completed:number;total:number;skipped:number;covered:number;scope:number;activityLabel:string|null;scopeLabel:string|null;distribution:Record<Evidence['state'],number>;change:string|null};
}
export interface SylloraState {
  uiPreferences?:{name:string;theme:'light'|'dark';dailyMinutes:number;revision:number};
  activity?:Array<{id:string;courseId:string;at:number;kind:'task'|'chat'|'reading';minutes:number;taskId?:string;planVersion:number}>;
  courses:CourseView[];
  jobs:Array<{dismissedAt?:number;requestId?:string;resultMessageId?:string;id:string;courseId:string;state:string;message:string;model:string;calls:number;inputTokens:number|null;outputTokens:number|null;progress?:{stage:string;done:number;total:number;failures:string[];etaMs?:number};coverage?:JobCoverage|null;createdAt?:number;finishedAt?:number|null;elapsedMs?:number|null;promptVersion?:string;ruleVersion?:string;errorCode?:string|null;usageKnownCalls?:{input:number;output:number};classroomId?:string}>;
  settings:{consent:boolean;calls:number};
  projects?:Array<{id:string;path:string;name:string;error:string|null;deletion?:'pending'|'failed'}>;
  legacyCourses?:Array<{id:string;name:string;points:number}>;
}
