import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

/** The visible Markdown text, retaining word order and literal punctuation.
 * Images/HTML are hidden by the reader. Keep code literal and discard syntax only. */
export function readingText(text: string, kind?: string): string {
  if(kind === 'heading') return text
  const tree=fromMarkdown(text,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]})
  const visit=(node: {type:string;value?:string;children?:unknown[]}):string=>{
    if(['html','image','imageReference','definition','yaml'].includes(node.type))return ''
    if(node.type==='break')return '\n'
    if(typeof node.value==='string')return node.value
    return (node.children??[]).map(child=>visit(child as Parameters<typeof visit>[0])).join('')
  }
  return visit(tree)
}
export const normalizeReadingText=(text:string)=>text.replace(/\s+/g,'')

export function selectionBelongs(sources:{text:string;kind?:string}[], selection:string):boolean {
  const wanted=normalizeReadingText(selection)
  return wanted.length>0 && [sources.map(source=>source.text).join('\n'),sources.map(source=>readingText(source.text,source.kind)).join('\n')].some(text=>normalizeReadingText(text).includes(wanted))
}
