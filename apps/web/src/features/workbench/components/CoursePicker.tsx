'use client';

import { useState } from 'react';
import { Check, Search, ArrowUpRight, ChevronUp, ChevronDown } from 'lucide-react';
import type { Course } from '@/src/features/workbench/types';
import Modal from './Modal';
import CourseIcon from './CourseIcon';

/**
 * 课程选择浮层（需求一）。复用自既有的「更换课程」弹窗，新增键盘可达的
 * 上移/下移——排序以浮层为准，左栏拖拽与这里的按钮结果一致。
 * 课程数 ≥ 10 时显示搜索框（数量少时搜索只是噪声）。
 */
export default function CoursePicker({ courses, selected, onClose, onChoose, onMove }: {
  courses: Course[]; selected: string; onClose: () => void;
  onChoose: (id: string) => void;
  /** 上移/下移一项；不传时不显示排序按钮。 */
  onMove?: (id: string, direction: 'up' | 'down') => void;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const visible = courses.filter(course => course.name.toLowerCase().includes(trimmed));
  const searchable = courses.length >= 10;
  return <Modal title="选择课程" onClose={onClose}><p className="modal-description">选择一门正在学习的课程，继续当前学习模式。{onMove ? '上移 / 下移可调整左栏顺序。' : ''}</p>
    {searchable && <div className="search-box course-picker-search"><Search size={16} /><input aria-label="查找课程" autoFocus value={query} placeholder="查找课程…" onChange={e => setQuery(e.target.value)} /></div>}
    <div className="course-picker-list">{visible.map(course => {
      const index = courses.findIndex(item => item.id === course.id);
      return <div className={`course-picker-row ${course.id === selected ? 'selected' : ''}`} key={course.id}>
        <button className="course-picker-choose" aria-label={`切换到 ${course.name}`} onClick={() => onChoose(course.id)}><span className={`course-symbol ${course.color}`}><CourseIcon course={course} /></span><span><strong>{course.name}</strong><small>{course.materials.length} 份资料 · {course.chapter}</small></span>{course.id === selected ? <Check size={16} /> : <ArrowUpRight size={15} />}</button>
        {onMove && <div className="course-picker-move"><button aria-label={`${course.name} 上移`} title="上移" disabled={index <= 0 || trimmed !== ''} onClick={() => onMove(course.id, 'up')}><ChevronUp size={15} /></button><button aria-label={`${course.name} 下移`} title="下移" disabled={index >= courses.length - 1 || trimmed !== ''} onClick={() => onMove(course.id, 'down')}><ChevronDown size={15} /></button></div>}
      </div>;
    })}{!visible.length && <p>没有找到课程，换个关键词试试。</p>}</div>
  </Modal>;
}
