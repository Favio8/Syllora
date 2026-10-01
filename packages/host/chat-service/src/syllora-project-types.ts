/** Wire contracts shared by the browser and host; no Node or model-runtime imports. */
export interface FileCandidate { path:string;size:number;fingerprint:string|null;status:'ready'|'unsupported'|'too-large'|'unreadable';change:'added'|'changed'|'unchanged';reason:string }
export interface LectureSection { text:string;sourceIds:string[] }
export interface Lecture {
  id:string;chapter:string;materialIds:string[];sourceIds:string[];
  intro:LectureSection;
  concepts:Array<LectureSection&{name:string;quote:string}>;
  examples:Array<LectureSection&{title:string;quote:string}>;
  connections:LectureSection[];analogies:LectureSection[];
}
