import type { Course, Question, Evidence, Material, NextAction, PlanDiff, DetailedPlanDiff } from '../../../../packages/host/chat-service/src/syllora-domain'
export type { Task, Source, Material, PageIssue, MaterialFile } from '../../../../packages/host/chat-service/src/syllora-domain'
export type CourseView = Omit<Course, 'questions'|'materials'> & {
  /** PRD 6.3: the server attaches the preview URL for materials that kept their original. */
  materials: Array<Material & { previewUrl: string | null }>;
  questions: Array<Omit<Question,'answer'|'explanation'|'quote'> & Partial<Pick<Question,'answer'|'explanation'|'quote'>>>;
  evidence: Record<string,Evidence>;
  next: NextAction;
  draftDiff: PlanDiff | null;
  detailedDraftDiff: DetailedPlanDiff | null;
  progress:{completed:number;total:number;skipped:number;covered:number;scope:number;activityLabel:string|null;scopeLabel:string|null;distribution:Record<Evidence['state'],number>;change:string|null};
}
/** PRD 17.4: which fragment range a generation actually used. */
export interface JobCoverage { sourcesUsed:number; sourcesTotal:number; charsUsed:number; charsTotal:number; materialsWithOmitted:string[] }
export interface SylloraState {
  courses:CourseView[];
  jobs:Array<{id:string;courseId:string;state:string;message:string;model:string;calls:number;inputTokens:number|null;outputTokens:number|null;coverage:JobCoverage|null}>;
  settings:{consent:boolean;callLimit:number;calls:number;cost:null};
}
