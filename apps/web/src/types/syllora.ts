import type { Course, Question, Evidence, NextAction, PlanDiff, DetailedPlanDiff } from '../../../../packages/host/chat-service/src/syllora-domain'
export type { Task, Source } from '../../../../packages/host/chat-service/src/syllora-domain'
export type CourseView = Omit<Course, 'questions'> & {
  questions: Array<Omit<Question,'answer'|'explanation'|'quote'> & Partial<Pick<Question,'answer'|'explanation'|'quote'>>>;
  evidence: Record<string,Evidence>;
  next: NextAction;
  draftDiff: PlanDiff | null;
  detailedDraftDiff: DetailedPlanDiff | null;
  progress:{completed:number;total:number;skipped:number;covered:number;scope:number;activityLabel:string|null;scopeLabel:string|null;distribution:Record<Evidence['state'],number>;change:string|null};
}
export interface SylloraState {
  courses:CourseView[];
  jobs:Array<{id:string;courseId:string;state:string;message:string;model:string;calls:number;inputTokens:number|null;outputTokens:number|null}>;
  settings:{consent:boolean;callLimit:number;calls:number;cost:null};
}
