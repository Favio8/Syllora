import Highlight from '@tiptap/extension-highlight';
import mark from 'markdown-it-mark';

/** Keep highlights as portable ==text== Markdown, including save/reopen. */
export const NotesHighlight = Highlight.extend({
  addStorage() {
    return {
      markdown: {
        serialize: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
        parse: { setup(markdown: { use: (plugin: typeof mark) => unknown }) { markdown.use(mark); } },
      },
    };
  },
});
