'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Plus, GraduationCap, FolderOpen, BrainCircuit, UserRound, Settings, CircleHelp, LogOut, ChevronRight, ShieldCheck, X } from 'lucide-react';
import type { Course, View } from '@/src/features/workbench/types';
import CourseIcon from './CourseIcon';
import CoursePicker from './CoursePicker';

export type UserAction = 'profile' | 'settings' | 'guide' | 'agreement' | 'logout';

/** 溢出探测：每个课程图标占 44px 高 + 9px 间隙（见 workbench.css 的
 *  `.rail-button` / `.rail-courses`）。容差向上取（宁可早一项折叠，也不让末项
 * 被裁掉一半），因此用 +0.5px 再取整，整数倍高度仍判为「放得下」。 */
const RAIL_SLOT_PX = 53;
const RAIL_SLOT_TOLERANCE_PX = 0.5;

export default function Sidebar({ courses, selected, view, mobileOpen, onClose, onView, onCourse, onCreate, onUserAction, onReorder }: {
  courses: Course[]; selected: string; view: View; mobileOpen: boolean; onClose: () => void; onView: (view: View) => void; onCourse: (id: string) => void; onCreate: () => void; onUserAction: (action: UserAction) => void;
  /** 需求一：拖拽/浮层排序落位后回调（全部课程的完整顺序）。 */
  onReorder?: (ids: string[]) => void;
}) {
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  /** 需求一：课程数超出可用高度时，末尾固定显示「…」折叠按钮。 */
  const [railCapacity, setRailCapacity] = useState<number>(Infinity);
  /** 拖拽中的课程 id（不含落位）；用 ref 记源、state 只驱动视觉。 */
  const [dragging, setDragging] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLButtonElement>(null);
  // 「学习工作台」导航项已移除：点侧栏/主页里的课程就是同一跳转，重复入口只添乱。
  const nav = [{ id: 'courses', label: '我的课程', icon: GraduationCap }, { id: 'materials', label: '资料库', icon: FolderOpen }, { id: 'review', label: '复习与巩固', icon: BrainCircuit }] as const;

  // 溢出探测：测量课程列可用高度换算成可容纳的图标数（窗口尺寸变化时重算）。
  useEffect(() => {
    const element = railRef.current;
    if (element === null) return;
    const measure = () => {
      // 高度为 0 表示尚未布局或环境无法测量（如 SSR 首帧、测试环境）——
      // 此时不折叠，避免把全部课程误藏起来。
      const height = element.clientHeight;
      setRailCapacity(height <= 0 ? Infinity : Math.floor((height + RAIL_SLOT_TOLERANCE_PX) / RAIL_SLOT_PX));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  /** 排序结果落位：先乐观更新（拖拽即时反馈），失败时回落到服务端顺序。 */
  function commit(ids: string[]) {
    if (!onReorder || ids.length === 0) return;
    onReorder(ids);
  }
  function reorderById(id: string, targetIndex: number) {
    const ids = courses.map(course => course.id);
    const from = ids.indexOf(id);
    if (from < 0 || targetIndex < 0 || targetIndex >= ids.length || from === targetIndex) return;
    ids.splice(targetIndex, 0, ids.splice(from, 1)[0]!);
    commit(ids);
  }
  // 浮层里的排序：本地先落位（列表即时反馈），父层持久化。
  const pickerCourses = moveIds === null ? courses : moveIds.map(id => courses.find(course => course.id === id)).filter((course): course is Course => course !== undefined);
  function pickerMove(id: string, direction: 'up' | 'down') {
    const ids = pickerCourses.map(course => course.id);
    const from = ids.indexOf(id);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    setMoveIds(ids);
    commit(ids);
  }

  function showLabel(e: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>, label: string) {
    if (menu) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ label, x: rect.right + 12, y: rect.top + rect.height / 2 });
  }
  function closeMenu() { setMenu(null); setHelpOpen(false); }
  function action(value: UserAction) { closeMenu(); setTooltip(null); onUserAction(value); onClose(); }
  function hoverProps(label: string) {
    return { 'aria-label': label, onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => showLabel(e, label), onMouseLeave: () => setTooltip(null), onFocus: (e: React.FocusEvent<HTMLButtonElement>) => showLabel(e, label), onBlur: () => setTooltip(null) };
  }
  useEffect(() => { setTooltip(null); closeMenu(); }, [view, selected, mobileOpen]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function outside(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node) && !userRef.current?.contains(e.target as Node)) closeMenu();
    }
    function key(e: KeyboardEvent) { if (e.key === 'Escape') { closeMenu(); userRef.current?.focus(); } }
    function resize() { closeMenu(); }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', resize); };
  }, [menu]);

  return <>
    {mobileOpen && <button className="mobile-backdrop" aria-label="关闭导航" onClick={onClose} />}
    <aside className={`sidebar icon-rail ${mobileOpen ? 'mobile-open' : ''}`} aria-label="主导航">
      <div className="rail-brand"><button className={`brand-icon ${view === 'home' ? 'is-home' : ''}`} {...hoverProps('返回主页')} onClick={() => { setTooltip(null); onView('home'); }}><BookOpen size={23} strokeWidth={1.8} /></button><button className="icon-button mobile-only rail-mobile-close" onClick={onClose} aria-label="关闭侧栏"><X size={15} /></button></div>
      <button className="rail-button rail-create" {...hoverProps('新建课程')} onClick={() => { setTooltip(null); onCreate(); }}><Plus size={21} /></button>
      <nav className="rail-nav">{nav.map(({ id, label, icon: Icon }) => <button className={`rail-button ${view === id ? 'active' : ''}`} aria-current={view === id ? 'page' : undefined} key={id} {...hoverProps(label)} onClick={() => { setTooltip(null); onView(id); }}><Icon size={21} strokeWidth={1.65} /></button>)}</nav>
      <div className="rail-divider" />
      {(() => {
        // 需求一：可用高度内排列；超出时末尾固定「…」折叠按钮。留一个槽位给
        // 「…」自身，保证按钮永远可见且可点。
        const overflow = courses.length > railCapacity;
        const visible = overflow ? courses.slice(0, Math.max(0, railCapacity - 1)) : courses;
        return <div className="rail-courses" ref={railRef} aria-label="正在学习的课程">
          {visible.map(course => <button
            key={course.id}
            className={`rail-button rail-course ${course.color} ${selected === course.id && view === 'workspace' ? 'selected' : ''} ${dragging === course.id ? 'is-dragging' : ''}`}
            {...hoverProps(`${course.name} · ${course.points.length} 个知识点${onReorder ? ' · 可拖动排序' : ''}`)}
            draggable={Boolean(onReorder)}
            onDragStart={onReorder ? e => { setDragging(course.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', course.id); } : undefined}
            onDragOver={onReorder ? e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } : undefined}
            onDrop={onReorder ? e => { e.preventDefault(); const source = e.dataTransfer.getData('text/plain') || dragging; setDragging(null); if (source) reorderById(source, courses.findIndex(item => item.id === course.id)); } : undefined}
            onDragEnd={onReorder ? () => setDragging(null) : undefined}
            onClick={() => { setTooltip(null); onCourse(course.id); }}
          ><CourseIcon course={course} />{selected === course.id && view === 'workspace' && <span className="rail-current-dot" />}</button>)}
          {overflow && <button className="rail-button rail-courses-more" {...hoverProps('查看全部课程')} aria-haspopup="dialog" onClick={() => { setTooltip(null); setMoveIds(courses.map(course => course.id)); setPickerOpen(true); }}>…</button>}
        </div>;
      })()}
      <div className="rail-bottom"><button ref={userRef} className={`rail-button rail-user ${menu ? 'active' : ''}`} {...hoverProps('用户')} aria-haspopup="menu" aria-expanded={Boolean(menu)} aria-controls={menu ? 'user-menu' : undefined} onClick={() => {
        setTooltip(null);
        if (menu) { closeMenu(); return; }
        const rect = userRef.current!.getBoundingClientRect();
        setMenu({ x: rect.right + 13, y: Math.max(12, Math.min(rect.bottom - 195, window.innerHeight - 208)) });
      }}><UserRound size={22} strokeWidth={1.65} /></button></div>
    </aside>
    {tooltip && createPortal(<span className="rail-tooltip" role="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>{tooltip.label}</span>, document.body)}
    {menu && createPortal(<div ref={menuRef} className="user-menu" id="user-menu" role="menu" aria-label="用户菜单" style={{ left: menu.x, top: menu.y }} onFocusCapture={e => { if (!(e.target as HTMLElement).closest('.help-menu-item')) setHelpOpen(false); }} onKeyDown={e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button, :scope > .help-menu-item > button'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault(); buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <button role="menuitem" onClick={() => action('profile')}><UserRound size={16} />用户资料</button>
      <button role="menuitem" onClick={() => action('settings')}><Settings size={16} />设置</button>
      <div className="help-menu-item" onMouseEnter={() => setHelpOpen(true)} onMouseLeave={() => setHelpOpen(false)}><button role="menuitem" aria-haspopup="menu" aria-expanded={helpOpen} onFocus={() => setHelpOpen(true)} onClick={() => setHelpOpen(true)} onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); setHelpOpen(true); setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('.help-submenu button')?.focus(), 0); } }}><CircleHelp size={16} />帮助<ChevronRight size={13} /></button>{helpOpen && <div className="help-submenu" role="menu" aria-label="帮助菜单" onKeyDown={e => { e.stopPropagation(); if (e.key === 'ArrowLeft') { setHelpOpen(false); menuRef.current?.querySelector<HTMLButtonElement>('.help-menu-item > button')?.focus(); } }}><button role="menuitem" onClick={() => action('guide')}><BookOpen size={15} />用户指南</button><button role="menuitem" onClick={() => action('agreement')}><ShieldCheck size={15} />协议说明</button></div>}</div>
      <button className="logout-menu-item" role="menuitem" onClick={() => action('logout')}><LogOut size={16} />结束当前会话</button>
    </div>, document.body)}
    {pickerOpen && <CoursePicker courses={pickerCourses} selected={selected} onClose={() => { setPickerOpen(false); setMoveIds(null); }} onChoose={id => { setPickerOpen(false); setMoveIds(null); onCourse(id); }} {...(onReorder ? { onMove: pickerMove } : {})} />}
  </>;
}
