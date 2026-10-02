'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, ChevronDown, Ellipsis, Pencil, Trash2, ArrowLeftRight } from 'lucide-react';
import type { Course } from '@/types';

export type CourseAction = 'rename' | 'archive' | 'restore' | 'delete';

export default function CourseMenu({ course, onAction, variant = 'catalog', onChangeCourse }: { course: Course; onAction: (course: Course, action: CourseAction) => void; variant?: 'catalog' | 'workspace'; onChangeCourse?: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function outside(e: PointerEvent) { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setPosition(null); }
    function move() { setPosition(null); }
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', move); window.addEventListener('scroll', move, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', move); window.removeEventListener('scroll', move, true); };
  }, [position]);
  function action(value: CourseAction) { setPosition(null); onAction(course, value); }
  return <><button ref={trigger} className={`icon-button ${variant === 'workspace' ? 'course-options-trigger' : 'course-manage-trigger'}`} aria-label={variant === 'workspace' ? `课程选项 ${course.name}` : `管理课程 ${course.name}`} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => { if (position) { setPosition(null); return; } const rect = trigger.current!.getBoundingClientRect(); setPosition({ left: Math.max(12, Math.min(variant === 'workspace' ? rect.left : rect.right - 170, window.innerWidth - 182)), top: Math.max(12, Math.min(rect.bottom + 7, window.innerHeight - 154)) }); }}>{variant === 'workspace' ? <ChevronDown size={15} /> : <Ellipsis size={19} />}</button>{position && createPortal(<div ref={menu} className="course-action-menu" role="menu" aria-label={`课程管理 ${course.name}`} style={position} onKeyDown={e => { const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button')); if (e.key === 'Escape' || e.key === 'Tab') { setPosition(null); if (e.key === 'Escape') { e.preventDefault(); trigger.current?.focus(); } } if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); } }}>{variant === 'workspace' ? <><button role="menuitem" onClick={() => { setPosition(null); onChangeCourse?.(); }}><ArrowLeftRight size={15} />更换课程</button><button role="menuitem" onClick={() => action('archive')}><Archive size={15} />课程归档</button><button role="menuitem" onClick={() => action('rename')}><Pencil size={15} />重命名</button></> : <><button role="menuitem" onClick={() => action('rename')}><Pencil size={15} />重命名</button><button role="menuitem" onClick={() => action(course.archived ? 'restore' : 'archive')}>{course.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{course.archived ? '恢复课程' : '归档课程'}</button><button role="menuitem" className="danger-action" onClick={() => action('delete')}><Trash2 size={15} />删除课程</button></>}</div>, document.body)}</>;
}
