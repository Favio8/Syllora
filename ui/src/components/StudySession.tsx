'use client';

import { useState } from 'react';
import { ArrowRight, Check, CircleCheck, Clock3, Lightbulb } from 'lucide-react';
import type { Course, Task } from '@/types';
import Modal from './Modal';
import CourseIcon from './CourseIcon';

export default function StudySession({ course, task, onClose, onComplete, error }: { course: Course; task: Task; onClose: () => void; onComplete: () => Promise<void>; error: string }) {
  const [answer, setAnswer] = useState('');
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const question = course.id === 'linear-algebra' ? { title: 'a = (1, 2)，b = (2, 4)。这两个向量的关系是？', options: ['线性相关，因为 b = 2a', '线性无关，因为它们长度不同', '无法判断'], explanation: 'b = 2a，因此 b 可以由 a 缩放得到。它没有带来新的独立方向，所以两个向量线性相关。' } : course.id === 'probability' ? { title: '两次投掷公平硬币，已知至少一次正面。两次都是正面的概率是？', options: ['1/3', '1/2', '1/4'], explanation: '已知条件下，等可能结果为正正、正反、反正，其中只有正正满足目标，所以概率是 1/3。' } : course.id === 'python' ? { title: 'Python 中，一个函数没有 return 语句时，默认返回什么？', options: ['None', '0', '空字符串'], explanation: '函数没有显式返回值时，Python 默认返回 None。print 只负责输出，不会替代 return。' } : { title: '阅读一段资料后，哪种方式更有助于检验理解？', options: ['合上资料，用自己的话解释核心概念', '逐字复制资料内容', '只浏览结论，不思考理由'], explanation: '用自己的话解释概念，能发现理解中的空白，再带着具体问题回到资料。这是新课程的通用练习演示。' };
  return <Modal error={error} title={task.kind === '复习' ? '巩固一下' : '专注学习'} wide onClose={onClose}><div className="session-heading"><span className={`course-symbol ${course.color}`}><CourseIcon course={course} /></span><div><small>{course.name} · {task.kind}</small><h3>{task.title}</h3></div><span className="session-time"><Clock3 size={14} />{task.minutes} 分钟</span></div><div className="session-tip"><Lightbulb size={18} /><p>先独立思考，再查看解释。把自己的理由说清楚，比猜对答案更有价值。</p></div><div className="practice-question"><span className="eyebrow">练习预览</span><h3>{question.title}</h3><fieldset><legend className="sr-only">选择答案</legend>{question.options.map((option, index) => <label className={`answer-option ${answer === String(index) ? 'selected' : ''}`} key={option}><input type="radio" name="practice-answer" checked={answer === String(index)} value={index} onChange={e => { setAnswer(e.target.value); setChecked(false); }} /><span>{String.fromCharCode(65 + index)}</span>{option}</label>)}</fieldset>{checked && <div className={`answer-feedback ${answer === '0' ? 'correct' : ''}`} role="status"><strong>{answer === '0' ? <><CircleCheck size={17} />回答正确</> : '再想一想，正确答案是 A'}</strong><p>{question.explanation}</p></div>}</div><div className="modal-actions"><button className="button" disabled={!answer} onClick={() => setChecked(true)}>查看解释</button><button className="button primary" disabled={saving || (task.id === 'practice-demo' && !checked)} onClick={async () => { setSaving(true); await onComplete(); setSaving(false); }}><Check size={16} />{saving ? '正在保存…' : task.completed ? '已完成，返回工作台' : '完成本次活动'}<ArrowRight size={15} /></button></div><p className="modal-footnote">这是本地练习演示；活动完成不会自动更改知识点的证据状态。</p></Modal>;
}
