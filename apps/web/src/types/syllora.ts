import type { Course, Question, Evidence } from '../../../../packages/host/chat-service/src/syllora-domain'
export type { Task, Source } from '../../../../packages/host/chat-service/src/syllora-domain'
export type CourseView = Omit<Course, 'questions'> & {
  questions: Array<Omit<Question,'answer'|'explanation'|'quote'> & Partial<Pick<Question,'answer'|'explanation'|'quote'>>>;
  evidence: Record<string,Evidence>;
  next: {text:string;pointId:string|null;taskId:string|null};
  progress:{completed:number;total:number;covered:number;scope:number};
}
export interface SylloraState {
  courses:CourseView[];
  jobs:Array<{id:string;courseId:string;state:string;message:string;model:string;calls:number;inputTokens:number|null;outputTokens:number|null}>;
  settings:{consent:boolean;callLimit:number;calls:number;cost:null};
}
