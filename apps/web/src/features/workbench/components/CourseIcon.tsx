import { resolveCourseIcon } from '@/src/features/workbench/lib/courseIcons';
import type { Course, CourseIconId } from '@/src/features/workbench/types';

export default function CourseIcon({ course, icon, size = 21 }: { course?: Pick<Course, 'id' | 'icon' | 'symbol'>; icon?: CourseIconId; size?: number }) {
  const option = resolveCourseIcon(course, icon);
  const Icon = option.icon;
  return <Icon size={size} strokeWidth={1.7} data-course-icon={option.id} aria-hidden="true" />;
}
