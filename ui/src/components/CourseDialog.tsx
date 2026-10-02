'use client';

import { useState } from 'react';
import { ArrowUpRight, Check } from 'lucide-react';
import Modal from './Modal';
import CourseIcon from './CourseIcon';
import { courseIcons } from '@/lib/courseIcons';
import type { Course, CourseIconId } from '@/types';

export default function CourseDialog({ mode, course, error, onClose, onSave }: { mode: 'create' | 'rename'; course?: Course; error: string; onClose: () => void; onSave: (name: string, icon?: CourseIconId) => Promise<boolean> }) {
  const [name, setName] = useState(mode === 'rename' ? course?.name ?? '' : '');
  const [icon, setIcon] = useState<CourseIconId | undefined>();
  const [saving, setSaving] = useState(false);
  const option = courseIcons.find(item => item.id === icon);
  return <Modal title={mode === 'create' ? '开始一门新课程' : '重命名课程'} error={error} onClose={onClose}>
    <p className="modal-description">{mode === 'create' ? '为课程选一个名字，再给它一个容易认出的图标。' : '一个清晰的名字，让课程更容易找到。'}</p>
    <form onSubmit={async e => { e.preventDefault(); if (mode === 'create' && !icon) return; setSaving(true); await onSave(name, icon); setSaving(false); }}>
      <div className="form-field"><span id="course-name-label">课程名称</span><input aria-labelledby="course-name-label" autoFocus required maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder="例如：高等数学" /></div>
      {mode === 'create' && <><fieldset className="course-icon-picker"><legend>选择课程图标 <span>请选择一个</span></legend><div className="icon-choice-grid">{courseIcons.map(({ id, label, icon: Icon }) => <label className={`icon-choice ${icon === id ? 'selected' : ''}`} key={id}><input type="radio" name="course-icon" value={id} checked={icon === id} required onChange={() => setIcon(id)} aria-label={label} /><Icon size={22} strokeWidth={1.7} /><span>{label}</span>{icon === id && <Check size={10} className="icon-choice-check" />}</label>)}</div></fieldset><div className="course-identity-preview"><span className={`course-symbol ${option?.color ?? 'blue'} ${!icon ? 'unselected' : ''}`}><CourseIcon icon={icon} /></span><div><strong>{name.trim() || '你的新课程'}</strong><small>{option ? `${option.label}图标 · 将显示在左侧与课程列表` : '选择一个图标，预览课程的样子'}</small></div></div></>}
      <div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={!name.trim() || (mode === 'create' && !icon) || saving}>{saving ? '正在保存…' : mode === 'create' ? '创建课程' : '保存名称'}<ArrowUpRight size={15} /></button></div>
    </form>
  </Modal>;
}
