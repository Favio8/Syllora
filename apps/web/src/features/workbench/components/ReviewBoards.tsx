"use client";

/**
 * 「复习与巩固」页里的按课程复习区。
 *
 * 原先挂在工作台右侧看板的「复习」标签里；该标签删除后移到这里——只有这里
 * 拿到完整 CourseView（证据状态/到期时间/错题/学习设置/计划目标日期），
 * 而不是工作台那层有损投影。每个课程一个折叠区，默认收起。
 */

import type { CourseView } from "../../../types/syllora";
import { useState } from 'react';
import { BookOpen, ChevronDown } from 'lucide-react';
import { LearningPolicySettings, WrongAnswerHistory, WrongAnswerList } from "./ReviewSection";
import Modal from "./Modal";

const formatTime = (at: number, zone: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(at);
const dayOf = (at: number, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export default function ReviewBoards({ courses, query = '', busy, onSavePolicy, onSource, onDispute }: {
  courses: CourseView[];
  query?: string;
  busy: boolean;
  onSavePolicy: (courseId: string, settings: { baseVersion: number; reviewHours: number[]; sessionIdleMinutes: number }) => Promise<boolean>;
  onSource: (sourceId: string) => void;
  onDispute: (questionId: string) => void;
}) {
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  /** 「错题记录」弹窗放在本层（不放进 .sy-review），避开 .sy-review 后代选择器的样式污染。 */
  const [wrongOpen,setWrongOpen]=useState<{courseId:string;pointId:string}|null>(null);
  const wrongCourse=wrongOpen?courses.find(course=>course.id===wrongOpen.courseId):undefined;
  const matches=(course:CourseView,id:string)=>`${course.name} ${course.points.find(point=>point.id===id)?.name??''}`.toLowerCase().includes(query.trim().toLowerCase());
  const boards = courses.filter(course => !course.archived && course.scope.some(id=>matches(course,id)));
  if (boards.length === 0) return null;
  return (
    <div className="review-boards">
      {boards.map(course => {
        const dueAt = (id: string) => { const value = course.evidence[id]?.dueAt; return typeof value === 'number' ? value : null };
        const due = course.scope.filter(id => { const value = dueAt(id); return value !== null && value <= Date.now() }).length;
        return (
          <section className="review-board" key={course.id}>
            <button className="review-board-toggle" aria-expanded={Boolean(expanded[course.id])} aria-controls={`review-board-${course.id}`} onClick={()=>setExpanded(old=>({...old,[course.id]:!old[course.id]}))}>
              <BookOpen size={18}/><span><strong>{course.name}</strong><small>已选 {course.scope.length} 个知识点{due > 0 ? ` · 到期 ${due} 个` : ""}</small></span><ChevronDown size={17}/>
            </button>
            {expanded[course.id]&&<div id={`review-board-${course.id}`} className="review-board-body">
              {course.scope.filter(id=>matches(course,id)).map(id => {
                const evidence = course.evidence[id];
                const name = course.points.find(point => point.id === id)?.name ?? "知识点";
                const deadline = course.plan?.deadline ?? null;
                const own = dueAt(id);
                const overdue = deadline !== null && deadline !== '' && own !== null && dayOf(own, course.timezone) > deadline;
                return (
                  <div className="sy-review" key={id}>
                    <h3>{name}</h3>
                    <span className="sy-badge">{evidence?.state}</span>
                    <p>{evidence?.reason}</p>
                    <small>{own !== null ? `下次复习：${formatTime(own, course.timezone)}` : "尚未安排复习"}</small>
                    {overdue && <p role="status">目标日期外：请调整目标日期、继续学习或归档课程。</p>}
                    <WrongAnswerHistory course={course} pointId={id} onOpen={() => setWrongOpen({ courseId: course.id, pointId: id })} />
                  </div>
                );
              })}
              <LearningPolicySettings course={course} busy={busy} onSave={settings => onSavePolicy(course.id, settings)} />
            </div>}
          </section>
        );
      })}
      {wrongOpen&&wrongCourse&&<Modal title={"错题记录 · "+(wrongCourse.points.find(point=>point.id===wrongOpen.pointId)?.name??"知识点")} wide onClose={()=>setWrongOpen(null)}>
        {/* 资料来源 / 题目报错是普通 div 浮层，叠在 <dialog> 下面点不到——所以点这两个按钮时先关闭本弹窗。 */}
        <WrongAnswerList course={wrongCourse} pointId={wrongOpen.pointId} onSource={id=>{setWrongOpen(null);onSource(id)}} onDispute={id=>{setWrongOpen(null);onDispute(id)}} />
      </Modal>}
    </div>
  );
}
