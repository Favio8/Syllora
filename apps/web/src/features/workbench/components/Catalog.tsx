'use client';

import { useState } from 'react';
import { ArrowUpRight, BookOpen, Plus, Search, FileText, Upload, Trash2, RotateCcw, FolderOpen } from 'lucide-react';
import type { Course, View, KnowledgePoint } from '@/src/features/workbench/types';
function FileSize({bytes}:{bytes:number}) { return <>{bytes ? `${(bytes/1024).toFixed(1)} KiB` : '大小未知'}</>; }
import CourseIcon from './CourseIcon';
import CourseMenu, { type CourseAction } from './CourseMenu';
import Dropdown from './Dropdown';
import ReviewBoards from './ReviewBoards';
import type { CourseView } from '@/src/types/syllora';

export default function Catalog({ view, courses, courseViews, busy, onCourse, onCreate, onUpload, onDeleteMaterial, onReview, onManage, onSavePolicy, onProposeReview, onSource, onDispute }: {
  view: Exclude<View, 'workspace' | 'home'>;
  courses: Course[];
  /** 完整课程视图（复习区需要 evidence/dueAt/错题/学习设置；工作台投影是有损的）。 */
  courseViews: CourseView[];
  busy: boolean;
  onCourse: (id: string) => void;
  onCreate: () => void;
  onUpload: (courseId: string) => void;
  onDeleteMaterial: (courseId: string, materialId: string) => void;
  onReview: (courseId: string, point: KnowledgePoint) => void;
  onManage: (course: Course, action: CourseAction) => void;
  onSavePolicy: (courseId: string, settings: { baseVersion: number; reviewHours: number[]; sessionIdleMinutes: number }) => Promise<boolean>;
  onProposeReview: (courseId: string, pointId: string) => void;
  onSource: (sourceId: string) => void;
  onDispute: (questionId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [status, setStatus] = useState('active');
  const activeCourses = courses.filter(course => !course.archived);
  const title = view === 'courses' ? '每一门课，都有新的可能。' : view === 'materials' ? '把资料放好，把思路理清。' : '让学过的，真正留下来。';
  const description = view === 'courses' ? '你的课程、计划和学习记录，都在这里。' : view === 'materials' ? '讲义、笔记与习题，构成你自己的知识来源。' : '回到还不够熟悉的知识点，用独立练习巩固理解。';
  const visibleCourses = courses.filter(c => (status === 'all' || Boolean(c.archived) === (status === 'archived')) && c.name.toLowerCase().includes(query.toLowerCase()));
  const materials = activeCourses.flatMap(c => c.materials.map(m => ({ ...m, course: c }))).filter(m => (filter === 'all' || m.course.id === filter) && `${m.name} ${m.course.name}`.toLowerCase().includes(query.toLowerCase()));
  const points = activeCourses.flatMap(c => c.points.filter(p => ['待加强','待验证','初步掌握'].includes(p.state)).map(p => ({ ...p, course: c }))).filter(p => `${p.title} ${p.course.name}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="catalog-scroll"><div className="catalog-intro"><span className="eyebrow">{view === 'courses' ? '我的课程' : view === 'materials' ? '个人资料库' : '复习与巩固'}</span><h1>{title}</h1><p>{description}</p></div><div className="catalog-toolbar"><div className="search-box"><Search size={16} /><input aria-label="搜索课程或资料" placeholder={view === 'courses' ? '搜索课程…' : view === 'materials' ? '搜索资料或课程…' : '搜索知识点…'} value={query} onChange={e => setQuery(e.target.value)} /></div>{view === 'courses' && <button className="button primary" onClick={onCreate}><Plus size={16} />新建课程</button>}{view === 'materials' && <Dropdown label="按课程筛选资料" value={filter} onChange={setFilter} options={[{ value: 'all', label: '所有课程' }, ...activeCourses.map(c => ({ value: c.id, label: c.name }))]} />}</div>
    {view === 'courses' && <><div className="course-status-tabs" role="group" aria-label="课程状态">{[{ id: 'active', label: '正在学习', count: activeCourses.length }, { id: 'archived', label: '已归档', count: courses.length - activeCourses.length }, { id: 'all', label: '全部课程', count: courses.length }].map(item => <button key={item.id} className={status === item.id ? 'active' : ''} aria-pressed={status === item.id} onClick={() => setStatus(item.id)}>{item.label}<span>{item.count}</span></button>)}<p>归档保留资料与记录，恢复后继续学习。</p></div><div className="course-grid">{visibleCourses.map(course => { const done = course.tasks.filter(t => t.completed).length; return <article className={`course-card managed-course ${course.archived ? 'archived-course' : ''}`} key={course.id}><CourseMenu course={course} onAction={onManage} /><button className="course-card-content" aria-label={`打开课程 ${course.name}`} disabled={course.archived} onClick={() => onCourse(course.id)}><div className="course-card-top"><span className={`course-symbol large ${course.color}`}><CourseIcon course={course} size={26} /></span>{course.archived ? <span className="archive-tag">已归档</span> : <ArrowUpRight size={19} />}</div><h2>{course.name}</h2><p>{course.subtitle}</p><div className="course-card-meta"><span><FileText size={13} />{course.materials.length} 份资料</span><span><BookOpen size={13} />{course.points.length} 个知识点</span></div><div className="course-card-progress"><span>{course.archived ? '保留的学习进度' : '学习活动'}</span><strong>{done} / {course.tasks.length}</strong></div><div className="progress-track"><span style={{ width: `${course.tasks.length ? done / course.tasks.length * 100 : 0}%` }} /></div></button>{course.archived && <button className="restore-course-button" onClick={() => onManage(course, 'restore')}><RotateCcw size={13} />恢复课程</button>}</article>; })}{status !== 'archived' && <button className="add-course-card" onClick={onCreate}><span><Plus size={25} /></span><strong>开始一门新课程</strong><p>给好奇心，留一个位置。</p></button>}</div>{!visibleCourses.length && <div className="catalog-empty"><FolderOpen size={30} /><h3>{query ? '没有找到匹配的课程' : status === 'archived' ? '还没有归档课程' : '创建一门课程，开始学习'}</h3><p>{query ? '换一个关键词再试试。' : '课程卡片右上角可以管理、归档或删除课程。'}</p></div>}</>}
    {view === 'materials' && <><div className="list-heading"><span>{materials.length} 份学习资料</span><span>按课程整理</span></div><div className="materials-list">{materials.map(material => <article className="material-row" key={material.id}><span className={`file-type ${material.name.endsWith('.pdf') ? 'pdf' : 'md'}`}>{material.name.split('.').at(-1)?.toUpperCase() ?? 'FILE'}</span><div className="material-detail"><strong>{material.name}</strong><span>{material.course.name} · <FileSize bytes={material.size} /> · {material.addedAt}</span></div><button className="text-button material-course" onClick={() => onCourse(material.course.id)}>查看课程<ArrowUpRight size={14} /></button><button className="icon-button" aria-label={`移除资料 ${material.name}`} onClick={() => onDeleteMaterial(material.course.id, material.id)}><Trash2 size={16} /></button></article>)}</div><div className="library-add"><Upload size={19} /><div><strong>把新的资料加入课程</strong><p>TXT、Markdown 可本地阅读，资料保存到本机课程文件夹，初始化后可阅读正文。</p></div><button className="button" onClick={() => activeCourses.length ? onUpload(filter === 'all' ? activeCourses[0].id : filter) : onCreate()}>{activeCourses.length ? '添加资料' : '先创建课程'}<Plus size={15} /></button></div></>}
    {view === 'review' && <><div className="review-overview"><span className="review-overview-icon"><RotateCcw size={23} /></span><div><strong>{points.length} 个知识点，值得再看一遍。</strong><p>完成学习活动与验证理解，是两件不同的事。</p></div></div><div className="review-grid">{points.map(point => <article className="review-detail-card" key={point.id}><div><span className="task-kind review">待巩固</span><small>{point.course.name}</small></div><h2>{point.title}</h2><p>{point.chapter} · 建议用 10 分钟独立回顾</p><button className="button" onClick={() => onReview(point.course.id, point)}>开始巩固<ArrowUpRight size={15} /></button></article>)}</div><ReviewBoards courses={courseViews} busy={busy} onSavePolicy={onSavePolicy} onProposeReview={onProposeReview} onSource={onSource} onDispute={onDispute} /></>}
    {((view === 'materials' && !materials.length) || (view === 'review' && !points.length)) && <div className="catalog-empty"><FolderOpen size={34} /><h3>{query ? '没有找到匹配的内容' : view === 'review' ? '暂时没有待巩固的知识点' : '这里还没有学习资料'}</h3><p>{query ? '换一个关键词再试试。' : view === 'review' ? '继续学习，让理解慢慢积累。' : '添加一份讲义或笔记，开始整理你的知识。'}</p></div>}
  </div>;
}
