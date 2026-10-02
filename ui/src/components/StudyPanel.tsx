import { ArrowUpRight, Check, ChevronRight, Clock3, FileText, Plus, Upload, X, CircleCheck, BookOpen, RotateCcw } from 'lucide-react';
import type { Course, PanelTab, Task } from '@/types';

export function FileSize({ bytes }: { bytes: number }) { return <>{bytes >= 1000000 ? `${(bytes / 1000000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`}</>; }

export default function StudyPanel({ course, tab, open, dailyMinutes, onTab, onClose, onToggle, onStudy, onUpload }: {
  course: Course; tab: PanelTab; open: boolean; dailyMinutes: number; onTab: (tab: PanelTab) => void; onClose: () => void; onToggle: (task: Task) => void; onStudy: (task: Task) => void; onUpload: () => void;
}) {
  const completed = course.tasks.filter(t => t.completed).length;
  const progress = course.tasks.length ? Math.round(completed / course.tasks.length * 100) : 0;
  const verified = course.points.filter(p => p.state === '已验证').length;
  return <aside className={`study-panel ${open ? 'panel-open' : ''}`} aria-label="学习面板">
    <header className="panel-header"><span>学习面板</span><span className="panel-caption">一步一步，扎实掌握</span><button className="icon-button panel-close" aria-label="关闭学习面板" onClick={onClose}><X size={18} /></button></header>
    <div className="panel-tabs" role="tablist" aria-label="学习内容">{([['plan', '计划'], ['outline', '大纲'], ['materials', '资料'], ['review', '复习']] as const).map(([key, label]) => <button key={key} id={`tab-${key}`} role="tab" aria-selected={tab === key} aria-controls="study-tabpanel" className={tab === key ? 'active' : ''} onClick={() => onTab(key)}>{label}</button>)}</div>
    <div className="panel-body" key={tab} role="tabpanel" id="study-tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'plan' && <>
        <div className="section-heading"><h3>今天的学习</h3><span><Clock3 size={13} />{course.tasks.reduce((n, t) => n + t.minutes, 0)} 分钟</span></div>
        <div className="progress-card"><div><span>活动完成</span><strong>{completed}<small> / {course.tasks.length}</small></strong></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><p>{course.tasks.length ? progress === 100 ? '今天的任务完成了，给自己一点掌声。' : '每完成一步，都离目标更近一点。' : '添加资料，开始安排你的第一步。'}</p></div>
        <div className="task-list">{course.tasks.map((task, index) => <div className={`task-item ${task.completed ? 'completed' : ''}`} key={task.id}><div className="task-rail"><button className="task-check" aria-label={`${task.completed ? '取消完成' : '标记完成'}：${task.title}`} aria-pressed={task.completed} onClick={() => onToggle(task)}>{task.completed ? <Check size={13} strokeWidth={3} /> : <span>{index + 1}</span>}</button></div><button className="task-main" onClick={() => onStudy(task)}><span className={`task-kind ${task.kind === '复习' ? 'review' : ''}`}>{task.kind}</span><strong>{task.title}</strong><small><Clock3 size={12} />{task.minutes} 分钟<span>{task.completed ? '已完成' : '待开始'}</span></small></button>{!task.completed && <ChevronRight className="task-arrow" size={15} />}</div>)}</div>
        {!course.tasks.length && <div className="panel-empty"><BookOpen size={25} /><h4>从一份资料开始</h4><p>把讲义或笔记放进来，为课程做好准备。</p><button className="button primary small" onClick={onUpload}><Plus size={15} />添加资料</button></div>}
        <div className="learning-tip"><span>学习小贴士</span><p>合上笔记，用自己的话解释一遍。能讲清楚，才是真正理解的开始。</p></div>
      </>}
      {tab === 'outline' && <><div className="section-heading"><h3>知识地图</h3><span>{course.points.length} 个知识点</span></div><p className="panel-description">把零散的知识，连成清晰的脉络。</p><div className="outline-list">{course.points.map(point => <div key={point.id} className="outline-item"><span className={`knowledge-dot ${point.state === '已验证' ? 'verified' : point.state === '待巩固' ? 'consolidate' : ''}`} /><div><small>{point.chapter}</small><strong>{point.title}</strong><span className={`evidence ${point.state === '已验证' ? 'verified' : ''}`}>{point.state}</span></div></div>)}</div>{!course.points.length && <div className="panel-empty"><BookOpen size={25} /><h4>还没有课程大纲</h4><p>先添加学习资料，后续接入服务后可生成大纲。</p><button className="button small" onClick={onUpload}>添加资料</button></div>}</>}
      {tab === 'materials' && <><div className="section-heading"><h3>课程资料</h3><span>{course.materials.length} 份</span></div><button className="upload-zone" onClick={onUpload}><Upload size={22} /><strong>添加你的学习资料</strong><span>PDF、Markdown、TXT</span></button><div className="panel-file-list">{course.materials.map(file => <div className="panel-file" key={file.id}><span className="file-icon"><FileText size={19} /></span><div><strong>{file.name}</strong><small><FileSize bytes={file.size} /> · {file.addedAt}</small></div></div>)}</div><p className="panel-footnote">TXT、Markdown 可本地阅读；PDF 正文解析尚未接入。</p></>}
      {tab === 'review' && <><div className="section-heading"><h3>复习与巩固</h3><span><RotateCcw size={13} />温故知新</span></div><p className="panel-description">从还不够熟悉的地方，再向前一步。</p>{course.points.filter(p => p.state === '待巩固').map(p => <div className="review-card" key={p.id}><span className="task-kind review">待巩固</span><h4>{p.title}</h4><p>尝试独立解释这个概念，再用一道练习检验理解。</p><button className="text-button" onClick={() => onStudy({ id: p.id, title: p.title, kind: '复习', minutes: 10, completed: false })}>开始巩固 <ArrowUpRight size={15} /></button></div>)}{!course.points.some(p => p.state === '待巩固') && <div className="panel-empty"><CircleCheck size={27} /><h4>暂时没有待巩固的知识点</h4><p>继续学习，在练习中发现新的进步。</p></div>}<p className="panel-footnote">标记任务完成仅记录活动，不会自动改变知识点状态。</p></>}
    </div>
    <footer className="panel-footer"><div><span>已验证知识点</span><strong>{verified} <small>/ {course.points.length}</small></strong></div><div><span>每日学习目标</span><strong>{dailyMinutes} <small>分钟</small></strong></div></footer>
  </aside>;
}
