'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, Ellipsis, Pencil, Trash2 } from 'lucide-react';
import type { Course } from '@/src/features/workbench/types';

export type CourseAction = 'rename' | 'archive' | 'restore' | 'delete';

/**
 * 课程卡片的管理菜单（我的课程页）。
 * B6：原 `variant="workspace"`（含「更换课程」项）全仓无组件级引用——工作台的
 * 课程切换走左栏图标与课程选择浮层，这里只保留实际接线的一处，避免双份维护。
 */
export default function CourseMenu({ course, onAction }: { course: Course; onAction: (course: Course, action: CourseAction) => void }) {
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
  return <><button ref={trigger} className="icon-button course-manage-trigger" aria-label={`管理课程 ${course.name}`} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => { if (position) { setPosition(null); return; } const rect = trigger.current!.getBoundingClientRect(); setPosition({ left: Math.max(12, Math.min(rect.right - 170, window.innerWidth - 182)), top: Math.max(12, Math.min(rect.bottom + 7, window.innerHeight - 154)) }); }}><Ellipsis size={19} /></button>{position && createPortal(<div ref={menu} className="course-action-menu" role="menu" aria-label={`课程管理 ${course.name}`} style={position} onKeyDown={e => { const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button')); if (e.key === 'Escape' || e.key === 'Tab') { setPosition(null); if (e.key === 'Escape') { e.preventDefault(); trigger.current?.focus(); } } if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); } }}><button role="menuitem" onClick={() => action('rename')}><Pencil size={15} />重命名</button><button role="menuitem" onClick={() => action(course.archived ? 'restore' : 'archive')}>{course.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{course.archived ? '恢复课程' : '归档课程'}</button><button role="menuitem" className="danger-action" onClick={() => action('delete')}><Trash2 size={15} />删除课程</button></div>, document.body)}</>;
}
