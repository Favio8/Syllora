import { useEffect } from 'react';

/** Existing Host panels and migrated native dialogs share keyboard navigation. */
export function useModalFocus() {
  useEffect(()=>{
    let active:HTMLElement|null=null,previous:HTMLElement|null=null;
    const visible=(node:HTMLElement)=>node.getClientRects().length>0;
    const dialogs=()=>Array.from(document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"]')).filter(visible);
    const elements=(dialog:HTMLElement)=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(visible);
    const update=()=>{const current=dialogs().at(-1)??null;if(current===active)return;if(!current){previous?.focus();active=null;return;}previous=document.activeElement as HTMLElement;active=current;if(!current.contains(document.activeElement))elements(current)[0]?.focus();};
    const key=(event:KeyboardEvent)=>{const dialog=dialogs().at(-1);if(!dialog)return;if(event.key==='Escape'&&dialog.tagName!=='DIALOG'){event.preventDefault();dialog.querySelector<HTMLButtonElement>('header button[aria-label^="关闭"]')?.click();}if(event.key==='Tab'){const items=elements(dialog),first=items[0],last=items.at(-1);if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first?.focus();}}};
    const observer=new MutationObserver(update);observer.observe(document.body,{childList:true,subtree:true});document.addEventListener('keydown',key);return()=>{observer.disconnect();document.removeEventListener('keydown',key);};
  },[]);
}
