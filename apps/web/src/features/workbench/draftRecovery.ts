import { rememberServer, type DraftCache } from '../../components/syllora-drafts';
import type { SylloraState } from '../../types/syllora';
const key='syllora.unsaved-drafts.v1';
export function saveDraftRecovery(cache:DraftCache) {
  try{sessionStorage.setItem(key,JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([,draft])=>draft.revision!==draft.savedRevision))));return true;}catch{return false;}
}
export function recoverDrafts(cache:DraftCache,courses:Array<Pick<SylloraState['courses'][number],'id'|'drafts'>>):DraftCache {
  try {
    const stored=JSON.parse(sessionStorage.getItem(key)??'{}') as DraftCache;
    for(const course of courses) {
      if(cache[course.id])continue;
      const draft=stored[course.id];if(!draft||typeof draft.prompt!=='string'||draft.prompt.length>4000||!draft.answers||!Number.isInteger(draft.baseVersion??0))continue;
      if(!Object.values(draft.answers).every(option=>Number.isInteger(option)&&option>=0&&option<=3))continue;
      const answers=Object.fromEntries(course.drafts.answers.map(answer=>[answer.questionId,answer.option]));
      const same=draft.prompt===course.drafts.prompt&&JSON.stringify(Object.entries(draft.answers).sort())===JSON.stringify(Object.entries(answers).sort());
      cache=same?rememberServer(cache,course.id,course.drafts):{...cache,[course.id]:{...draft,revision:1,savedRevision:0,savedAt:0}};
    }
  }catch {/* Invalid browser data cannot create courses or evidence. */}
  return cache;
}
