'use client';

import type { KeyboardEvent, MouseEvent } from 'react';

/**
 * 点击即弹日历、不可手动输入的日期框。
 *
 * 原生 <input type="date"> 只有点右侧小图标才会弹出日历，中间是可手敲的分段输入。
 * 这里：
 *  - 点击输入框任意位置都调用 showPicker() 弹出系统日历；
 *  - 拦截键盘输入，防止手敲数字；仍放行 Tab / Shift+Tab（焦点移动），
 *    以及 Delete / Backspace（清空——目标日期是可选项，必须能撤销）；
 *  - Enter / 空格 也会弹出日历，保证键盘用户可以操作。
 */
export default function DatePickerInput({ value, onChange, disabled, ariaLabel, className }: { value: string; onChange: (value: string) => void; disabled?: boolean; ariaLabel?: string; className?: string }) {
  const open = (input: HTMLInputElement) => {
    try { input.showPicker(); } catch { /* 个别环境（如 iframe 内、未获得用户手势）不允许，原生图标仍可用 */ }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const { key } = event;
    if (key === 'Tab' || key === 'Escape') return;
    if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); if (value) onChange(''); return; }
    event.preventDefault();
    if (key === 'Enter' || key === ' ') open(event.currentTarget);
  };
  return <input
    type="date"
    className={className}
    value={value}
    disabled={disabled}
    aria-label={ariaLabel}
    onChange={event => onChange(event.target.value)}
    onClick={(event: MouseEvent<HTMLInputElement>) => open(event.currentTarget)}
    onKeyDown={onKeyDown}
    onPaste={event => event.preventDefault()}
    onDrop={event => event.preventDefault()}
  />;
}
