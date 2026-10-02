'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Plus, PanelsTopLeft, GraduationCap, FolderOpen, BrainCircuit, UserRound, Settings, CircleHelp, LogOut, ChevronRight, ShieldCheck, X } from 'lucide-react';
import type { Course, View } from '@/types';
import CourseIcon from './CourseIcon';

export type UserAction = 'profile' | 'settings' | 'guide' | 'agreement' | 'logout';

export default function Sidebar({ courses, selected, view, mobileOpen, onClose, onView, onCourse, onCreate, onUserAction }: {
  courses: Course[]; selected: string; view: View; mobileOpen: boolean; onClose: () => void; onView: (view: View) => void; onCourse: (id: string) => void; onCreate: () => void; onUserAction: (action: UserAction) => void;
}) {
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLButtonElement>(null);
  const nav = [{ id: 'workspace', label: '学习工作台', icon: PanelsTopLeft }, { id: 'courses', label: '我的课程', icon: GraduationCap }, { id: 'materials', label: '资料库', icon: FolderOpen }, { id: 'review', label: '复习与巩固', icon: BrainCircuit }] as const;

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
      <div className="rail-courses" aria-label="正在学习的课程">{courses.map(course => <button key={course.id} className={`rail-button rail-course ${course.color} ${selected === course.id && view === 'workspace' ? 'selected' : ''}`} {...hoverProps(course.name)} onClick={() => { setTooltip(null); onCourse(course.id); }}><CourseIcon course={course} />{selected === course.id && view === 'workspace' && <span className="rail-current-dot" />}</button>)}</div>
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
      <button className="logout-menu-item" role="menuitem" onClick={() => action('logout')}><LogOut size={16} />退出登录</button>
    </div>, document.body)}
  </>;
}
