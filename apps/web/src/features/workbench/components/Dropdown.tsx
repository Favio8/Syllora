'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface DropdownOption { value: string; label: string; description?: string }

/** The same floating list is used by document, course, and configuration selectors. */
export default function Dropdown({ label, value, options, onChange, disabled = false, placeholder = '请选择', className = '' }: { label: string; value: string; options: DropdownOption[]; onChange: (value: string) => void; disabled?: boolean; placeholder?: string; className?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [floating, setFloating] = useState<{ left: number; top: number; width: number; height: number; host: Element } | null>(null);
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find(option => option.value === value);

  function close(animate = true) {
    if (timer.current) clearTimeout(timer.current);
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setClosing(true);
      timer.current = setTimeout(() => { setFloating(null); setClosing(false); }, 120);
    } else { setFloating(null); setClosing(false); }
  }
  function open() {
    if (disabled || !options.length) return;
    if (timer.current) clearTimeout(timer.current);
    const rect = trigger.current!.getBoundingClientRect();
    const desired = Math.min(296, options.length * 48 + 16);
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const bottom = below >= Math.min(desired, 180) || below >= above;
    const height = Math.max(48, Math.min(desired, bottom ? below : above));
    const width = Math.min(Math.max(rect.width, 230), window.innerWidth - 24);
    setFloating({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: bottom ? rect.bottom + 8 : rect.top - height - 8, width, height, host: trigger.current!.closest('dialog') ?? document.body });
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    setClosing(false);
  }
  useEffect(() => {
    if (!floating) return;
    function outside(e: PointerEvent) { if (!trigger.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) close(); }
    function move(e: Event) { if (!list.current?.contains(e.target as Node)) close(false); }
    function escape(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); trigger.current?.focus(); } }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', move);
    window.addEventListener('scroll', move, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', move); window.removeEventListener('scroll', move, true); };
  }, [floating]);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function select(index: number) { onChange(options[index].value); close(); trigger.current?.focus(); }
  return <>
    <button ref={trigger} type="button" className={`dropdown-trigger ${floating && !closing ? 'is-open' : ''} ${className}`} role="combobox" aria-label={label} aria-expanded={Boolean(floating && !closing)} aria-haspopup="listbox" aria-controls={floating ? id : undefined} aria-activedescendant={floating ? `${id}-${active}` : undefined} disabled={disabled} onClick={() => floating && !closing ? close() : open()} onKeyDown={e => {
      if (e.key === 'Tab') { close(false); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        if (!floating || closing) { open(); return; }
        setActive(index => e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      } else if ((e.key === 'Enter' || e.key === ' ') && floating && !closing) { e.preventDefault(); select(active); }
    }}><span>{selected?.label ?? placeholder}</span><ChevronDown size={15} /></button>
    {floating && createPortal(<div ref={list} id={id} role="listbox" aria-label={label} className={`dropdown-list ${closing ? 'is-closing' : ''}`} style={{ left: floating.left, top: floating.top, width: floating.width, maxHeight: floating.height }}>{options.map((option, index) => <button type="button" role="option" aria-selected={value === option.value} id={`${id}-${index}`} tabIndex={-1} data-index={index} className={active === index ? 'focused' : ''} key={option.value} onMouseEnter={() => setActive(index)} onPointerDown={e => e.preventDefault()} onClick={() => select(index)}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{value === option.value && <Check size={15} />}</button>)}</div>, floating.host)}
  </>;
}
