'use client';

import { useMemo, useState } from 'react';
import { Activity, CalendarDays, Clock3, MessageSquareText } from 'lucide-react';
import { dayKey, recentDays } from '@/lib/activity';
import type { LearningRecord } from '@/types';

export default function LearningStats({ records = [] }: { records?: LearningRecord[] }) {
  const [period, setPeriod] = useState(14);
  const [includeDemo, setIncludeDemo] = useState(true);
  const [selectedDay, setSelectedDay] = useState(dayKey());
  const today = dayKey();
  const days = recentDays(84, today);
  const hasDemo = records.some(record => record.demo);
  const visible = useMemo(() => records.filter(record => includeDemo || !record.demo), [records, includeDemo]);
  const summary = (date: string) => {
    const entries = visible.filter(record => record.date === date);
    return { count: entries.length, minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0) };
  };
  const chartDays = recentDays(period, today);
  const values = chartDays.map(date => summary(date).minutes);
  const max = Math.max(40, ...values);
  const points = values.map((value, i) => [36 + i / (values.length - 1) * 464, 150 - value / max * 118]);
  const path = points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const totalMinutes = chartDays.reduce((sum, date) => sum + summary(date).minutes, 0);
  const activeDays = chartDays.filter(date => summary(date).count).length;
  const pad = (new Date(`${days[0]}T12:00:00+08:00`).getUTCDay() + 6) % 7;
  const focus = summary(selectedDay);
  return <section className="learning-statistics" aria-label="学习数据统计"><div className="home-section-heading"><h2>你的学习足迹</h2>{hasDemo && <button className={`stats-demo-toggle ${includeDemo ? 'active' : ''}`} aria-pressed={includeDemo} onClick={() => setIncludeDemo(!includeDemo)}>展示演示记录</button>}</div><div className="stats-summary"><div><CalendarDays size={17} /><span>近 {period} 天学习天数<strong>{activeDays}<small>天</small></strong></span></div><div><Clock3 size={17} /><span>完成活动建议时长<strong>{totalMinutes}<small>分钟</small></strong></span></div><div><MessageSquareText size={17} /><span>近 {period} 天互动次数<strong>{visible.filter(record => chartDays.includes(record.date) && ['chat', 'reading'].includes(record.kind)).length}<small>次</small></strong></span></div></div><div className="stats-chart-grid"><article className="stats-card stats-calendar"><header><div><h3><Activity size={15} />学习热力图</h3><p>近 12 周，每一格都是一个学习日。</p></div><span>{hasDemo && includeDemo ? '含演示记录' : '本地记录'}</span></header><div className="heatmap-layout"><div className="heatmap-weekdays">{['一', '', '三', '', '五', '', '日'].map((day, i) => <span key={i}>{day}</span>)}</div><div className="heatmap-grid">{Array.from({ length: pad }, (_, i) => <i key={`pad-${i}`} />)}{days.map(date => { const activity = summary(date); return <button className={`heatmap-cell level-${Math.min(activity.count, 4)} ${date === selectedDay ? 'selected' : ''}`} key={date} title={`${date} · ${activity.count} 次活动 · ${activity.minutes} 分钟建议时长`} aria-label={`${date}，${activity.count} 次学习活动`} aria-pressed={date === selectedDay} onClick={() => setSelectedDay(date)} />; })}</div></div><div className="heatmap-footer"><span>{selectedDay.slice(5).replace('-', '/')} · {focus.count} 次活动</span><div><span>少</span>{[0, 1, 2, 3, 4].map(level => <i className={`level-${level}`} key={level} />)}<span>多</span></div></div></article><article className="stats-card stats-trend"><header><div><h3>学习趋势</h3><p>完成活动的建议时长 / 分钟</p></div><div className="stats-period" role="group" aria-label="统计范围">{[7, 14, 30].map(count => <button aria-pressed={period === count} className={period === count ? 'active' : ''} key={count} onClick={() => setPeriod(count)}>{count} 天</button>)}</div></header><svg viewBox="0 0 520 182" role="img" aria-label={`近 ${period} 天活动建议时长趋势，总计 ${totalMinutes} 分钟`}><defs><linearGradient id="stats-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#002FA7" stopOpacity=".13" /><stop offset="100%" stopColor="#002FA7" stopOpacity="0" /></linearGradient></defs>{[0, .5, 1].map(ratio => <g key={ratio}><line x1="36" x2="500" y1={150 - ratio * 118} y2={150 - ratio * 118} stroke="#edf1f7" strokeDasharray="3 4" /><text x="26" y={154 - ratio * 118} textAnchor="end">{Math.round(max * ratio)}</text></g>)}<path d={`${path} L 500 150 L 36 150 Z`} fill="url(#stats-fill)" /><path className="stats-line" d={path} fill="none" stroke="#002FA7" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />{points.map(([x, y], i) => <circle key={chartDays[i]} cx={x} cy={y} r="3.5" fill="white" stroke="#002FA7" strokeWidth="1.5"><title>{chartDays[i]}：{values[i]} 分钟</title></circle>)}<text x="36" y="176">{chartDays[0].slice(5).replace('-', '/')}</text><text x="500" y="176" textAnchor="end">今天</text></svg></article></div><p className="stats-footnote">建议时长来自已完成的学习活动，非实际计时；对话和阅读操作仅计入互动次数。{hasDemo && includeDemo ? '浅色开关可切换为仅查看你的本地记录。' : ''}</p></section>;
}
