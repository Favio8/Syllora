'use client';

import {useId, useState, type ReactNode} from 'react';
import {History, Activity, SlidersHorizontal, ChevronDown} from 'lucide-react';

/** Review tools have explicit keyboard-accessible buttons and retain their drafts. */
export default function ReviewDisclosure({title, icon, children}: {title: string; icon: 'history'|'activity'|'settings'; children: ReactNode}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const Icon = {history: History, activity: Activity, settings: SlidersHorizontal}[icon];
  return <section className="review-disclosure">
    <button type="button" className="review-tool-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span><Icon size={15}/>{title}</span><ChevronDown size={14}/>
    </button>
    <div id={id} className="review-disclosure-body" hidden={!open} role="region" aria-label={title}>{children}</div>
  </section>;
}
