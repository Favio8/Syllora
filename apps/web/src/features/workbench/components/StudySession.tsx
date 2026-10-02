'use client';
import type { ReactNode } from 'react';
import { Clock3 } from 'lucide-react';
import Modal from './Modal';
import CourseIcon from './CourseIcon';
import type { Course } from '../types';
export default function StudySession({course,title,minutes,children,onClose,inline}:{course:Course;title:string;minutes:number;children:ReactNode;inline?:boolean;onClose:()=>void}) {
  if(inline)return children;
  return <Modal title="专注学习" onClose={onClose} wide className="study-session-dialog"><div className="session-heading"><span className={`course-symbol ${course.color}`}><CourseIcon course={course}/></span><div><small>{course.name}</small><h3>{title}</h3></div><span className="session-time"><Clock3 size={14}/>{minutes} 分钟（建议）</span></div>{children}</Modal>;
}
