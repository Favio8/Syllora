'use client';
import { Check } from 'lucide-react';
import { courseIcons } from '../lib/courseIcons';
import type { CourseIconId } from '../types';
export default function IconPicker({ value, onChange }: { value: string; onChange: (value: CourseIconId) => void }) {
  const selected = courseIcons.find(item => item.id === value);
  return <><fieldset className="course-icon-picker"><legend>课程图标 <span>选择一个适合这门课程的图标</span></legend><div className="icon-choice-grid">{courseIcons.map(({ id, label, icon: Icon }) => <label key={id} className={`icon-choice ${value === id ? 'selected' : ''}`}><input type="radio" name="course-icon" aria-label={label} checked={value === id} onChange={() => onChange(id)} /><Icon size={23} /><span>{label}</span>{value === id && <Check size={12} className="icon-choice-check" />}</label>)}</div></fieldset>{selected && <div className="course-identity-preview"><span className={`course-symbol ${selected.color}`}><selected.icon size={23} /></span><span>课程图标 · {selected.label}</span></div>}</>;
}
