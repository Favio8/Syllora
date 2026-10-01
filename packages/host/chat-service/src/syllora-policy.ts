/** Provisional conservative defaults; settings change future cycles, never prior event facts. */
export interface LearningSettings { revision:number;reviewHours:[number,number,number];sessionIdleMinutes:number }
export interface EvidenceRuleSnapshot { version:string;settingsRevision:number;reviewHours:[number,number,number] }
export const DEFAULT_REVIEW_HOURS:[number,number,number]=[24,72,168]
export function learningSettings(course:{learningSettings?:LearningSettings}):LearningSettings {
  return course.learningSettings??{revision:0,reviewHours:[...DEFAULT_REVIEW_HOURS],sessionIdleMinutes:30}
}
export function validReviewHours(value:unknown):value is [number,number,number] {
  return Array.isArray(value)&&value.length===3&&value.every(v=>Number.isSafeInteger(v)&&v>=24&&v<=8760)&&value[0]<=value[1]&&value[1]<=value[2]
}
