import { Sigma, ChartNoAxesCombined, Code2, FlaskConical, Atom, Languages, BookText, Palette, Music2, Globe2, Landmark, NotebookTabs } from 'lucide-react';
import type { Course, CourseIconId } from '@/src/features/workbench/types';

export const courseIcons = [
  { id: 'math', label: '数学', icon: Sigma, color: 'blue' },
  { id: 'statistics', label: '统计', icon: ChartNoAxesCombined, color: 'green' },
  { id: 'code', label: '编程', icon: Code2, color: 'orange' },
  { id: 'science', label: '化学', icon: FlaskConical, color: 'green' },
  { id: 'physics', label: '物理', icon: Atom, color: 'blue' },
  { id: 'language', label: '语言', icon: Languages, color: 'orange' },
  { id: 'literature', label: '文学', icon: BookText, color: 'blue' },
  { id: 'art', label: '艺术', icon: Palette, color: 'orange' },
  { id: 'music', label: '音乐', icon: Music2, color: 'green' },
  { id: 'geography', label: '地理', icon: Globe2, color: 'green' },
  { id: 'history', label: '历史', icon: Landmark, color: 'orange' },
  { id: 'notebook', label: '通用', icon: NotebookTabs, color: 'blue' },
] as const;

export function resolveCourseIcon(course?: Pick<Course, 'icon' | 'id' | 'symbol'>, icon?: CourseIconId) {
  const choice = icon ?? course?.icon;
  const existing = courseIcons.find(option => option.id === choice);
  if (existing) return existing;
  return courseIcons[11];
}
