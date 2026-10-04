import { ArrowRight, Clock3, Check, ChevronRight } from 'lucide-react';
import CourseIcon from './CourseIcon';
import { Fragment } from 'react';
import type { Course, LearningMode, Task, WorkspaceData } from '@/src/features/workbench/types';
import LearningStats from './LearningStats';

export default function Home({ data, selected, onCourse, onCreate, onCourses, onMaterials, onStudy }: { data: WorkspaceData; selected: string; onCourse: (id: string, mode?: LearningMode) => void; onCreate: () => void; onCourses: () => void; onMaterials: () => void; onStudy: (course: Course, task: Task) => void }) {
  const current = data.courses.find(c => c.id === selected) ?? data.courses[0];
  const next = current?.tasks.find(t => !t.completed&&t.available);
  const tasks = data.courses.flatMap(course => course.tasks.filter(t => !t.completed&&t.available).map(task => ({ course, task })));
  const completed = data.courses.flatMap(c => c.tasks).filter(t => t.completed).length;
  return <div className="home-scroll"><div className="home-content">
    <section className="home-welcome"><div><span className="eyebrow">SYLLORA · 你的学习起点</span><h1>{data.preferences.name}，今天想学点什么？</h1></div><span className="home-welcome-note">一点好奇心，<br />也是很好的开始。</span></section>
    <div className="home-primary-grid"><section className="home-continue"><div className="home-continue-top"><span className="blue-eyebrow"><span className="tiny-blue-dot" />{current ? '接着上一次，继续往前' : '你的第一门课，从这里开始'}</span>{current && <span className={`course-symbol ${current.color}`}><CourseIcon course={current} size={25} /></span>}</div><h2>{current?.name ?? '给想学的知识，留一个位置'}</h2><p>{next?.title ?? (current?.materials.length ? '翻开资料，把新的疑问一起弄明白。' : '添加一份讲义或笔记，慢慢建立你的知识地图。')}</p><div className="home-continue-bottom"><button className="button primary" onClick={() => current ? onCourse(current.id, 'chat') : onCreate()}>{current ? '继续学习' : '创建第一门课程'}<ArrowRight size={16} /></button>{next && <span><Clock3 size={13} />建议 {next.minutes} 分钟</span>}</div>{current && current.tasks.length > 0 && <div className="learning-route" aria-label="课程活动路径">{current.tasks.slice(0, 5).map((task, index) => <Fragment key={task.id}>{index > 0 && <i />}<button className={task.completed ? 'completed' : ''} disabled={!task.available&&!task.completed} aria-label={`学习活动：${task.title}`} title={task.title} onClick={() => onStudy(current, task)}>{task.completed ? <Check size={11} /> : index + 1}</button></Fragment>)}</div>}</section>
      <section className="home-today"><div className="home-section-heading"><h2>今天的小目标</h2><span>{tasks.length} 项待完成</span></div>{tasks.length ? <div className="home-task-list">{tasks.slice(0, 3).map(({ course, task }) => <button key={task.id} onClick={() => onStudy(course, task)}><span className={`home-task-icon ${course.color}`}><CourseIcon course={course} size={17} /></span><span><strong>{task.title}</strong><small>{course.name} · {task.minutes} 分钟</small></span><ChevronRight size={14} /></button>)}</div> : <p className="home-no-tasks">{data.courses.length ? '今天暂无可执行的计划活动，可以查看安排或翻开资料。' : '创建课程后，你的学习活动会出现在这里。'}</p>}<div className="home-today-footer"><Check size={13} /><span>已完成 {completed} 项活动</span><span>每日目标 {data.preferences.dailyMinutes} 分钟</span></div></section></div>
    <LearningStats records={data.activity} />
  </div></div>;
}
