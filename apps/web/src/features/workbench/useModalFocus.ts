import { useEffect } from 'react';

/** 可输入元素：焦点落在这些元素上时，任何"自动聚焦"都必须让位（需求一：
 *  输入过程中被抢焦点就是"无法输入"的直接成因）。 */
function isEditable(node: Element | null): boolean {
  if (!node) return false;
  const element = node as HTMLElement;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.isContentEditable === true;
}

/** Existing Host panels and migrated native dialogs share keyboard navigation. */
export function useModalFocus() {
  useEffect(()=>{
    let active:HTMLElement|null=null,previous:HTMLElement|null=null;
    const visible=(node:HTMLElement)=>node.getClientRects().length>0;
    const dialogs=()=>Array.from(document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"]')).filter(visible);
    const elements=(dialog:HTMLElement)=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(visible);
    const update=()=>{
      const current=dialogs().at(-1)??null;
      if(current===active)return;
      if(!current){
        // 弹层关闭后把焦点还给打开它的元素——但绝不从正在输入的元素上抢走：
        // 旧实现无条件 previous.focus()，任何一次 DOM 变动（轮询重渲染、列表
        // 刷新）都可能把光标从输入框拽走，表现为"打字打不进去"。
        active=null;
        const now=document.activeElement as HTMLElement|null;
        if(isEditable(now))return;
        if(now===null||now===document.body)previous?.focus();
        return;
      }
      const before=document.activeElement as HTMLElement|null;
      previous=isEditable(before)?previous:before;
      active=current;
      // 输入中不抢焦点（弹层自己会 autoFocus）；其余情况维持原有的首元素聚焦。
      if(!current.contains(document.activeElement)&&!isEditable(before))elements(current)[0]?.focus();
    };
    const key=(event:KeyboardEvent)=>{const dialog=dialogs().at(-1);if(!dialog)return;if(event.key==='Escape'&&dialog.tagName!=='DIALOG'){event.preventDefault();dialog.querySelector<HTMLButtonElement>('header button[aria-label^="关闭"]')?.click();}if(event.key==='Tab'){const items=elements(dialog),first=items[0],last=items.at(-1);if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first?.focus();}}};
    const observer=new MutationObserver(update);observer.observe(document.body,{childList:true,subtree:true});document.addEventListener('keydown',key);return()=>{observer.disconnect();document.removeEventListener('keydown',key);};
  },[]);
}
