'use client';

import { useState } from 'react';
import { Check, Search, ArrowUpRight } from 'lucide-react';
import type { Course } from '@/src/features/workbench/types';
import Modal from './Modal';
import CourseIcon from './CourseIcon';

export default function CoursePicker({ courses, selected, onClose, onChoose }: { courses: Course[]; selected: string; onClose: () => void; onChoose: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const visible = courses.filter(course => course.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <Modal title="更换课程" onClose={onClose}><p className="modal-description">选择一门正在学习的课程，继续当前学习模式。</p><div className="search-box course-picker-search"><Search size={16} /><input aria-label="查找课程" autoFocus value={query} placeholder="查找课程…" onChange={e => setQuery(e.target.value)} /></div><div className="course-picker-list">{visible.map(course => <button className={course.id === selected ? 'selected' : ''} aria-label={`切换到 ${course.name}`} key={course.id} onClick={() => onChoose(course.id)}><span className={`course-symbol ${course.color}`}><CourseIcon course={course} /></span><span><strong>{course.name}</strong><small>{course.materials.length} 份资料 · {course.chapter}</small></span>{course.id === selected ? <Check size={16} /> : <ArrowUpRight size={15} />}</button>)}{!visible.length && <p>没有找到课程，换个关键词试试。</p>}</div></Modal>;
}
