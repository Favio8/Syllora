"use client";

/**
 * 「复习与巩固」页里的按课程复习区。
 *
 * 原先挂在工作台右侧看板的「复习」标签里；该标签删除后移到这里——只有这里
 * 拿到完整 CourseView（证据状态/到期时间/错题/学习设置/计划目标日期），
 * 而不是工作台那层有损投影。每个课程一个折叠区，默认收起。
 */

import type { CourseView } from "../../../types/syllora";
import { LearningPolicySettings, WrongAnswerHistory } from "./ReviewSection";

const formatTime = (at: number, zone: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(at);
const dayOf = (at: number, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export default function ReviewBoards({ courses, busy, onSavePolicy, onProposeReview, onSource, onDispute }: {
  courses: CourseView[];
  busy: boolean;
  onSavePolicy: (courseId: string, settings: { baseVersion: number; reviewHours: number[]; sessionIdleMinutes: number }) => Promise<boolean>;
  onProposeReview: (courseId: string, pointId: string) => void;
  onSource: (sourceId: string) => void;
  onDispute: (questionId: string) => void;
}) {
  const boards = courses.filter(course => !course.archived && course.scope.length > 0);
  if (boards.length === 0) return null;
  return (
    <div className="review-boards">
      {boards.map(course => {
        const dueAt = (id: string) => { const value = course.evidence[id]?.dueAt; return typeof value === 'number' ? value : null };
        const due = course.scope.filter(id => { const value = dueAt(id); return value !== null && value <= Date.now() }).length;
        return (
          <details className="review-board" key={course.id}>
            <summary>
              <span>{course.name} · 已选 {course.scope.length} 个知识点{due > 0 ? ` · 到期 ${due} 个` : ""}</span>
            </summary>
            <div className="review-board-body">
              {course.scope.map(id => {
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
                    <WrongAnswerHistory course={course} pointId={id} onSource={onSource} onDispute={onDispute} />
                    <button disabled={busy || course.archived || (course.blockedPointIds ?? []).includes(id)} onClick={() => onProposeReview(course.id, id)}>
                      {own !== null && own <= Date.now() ? "生成到期复习草案" : "生成即时巩固草案"}
                    </button>
                  </div>
                );
              })}
              <LearningPolicySettings course={course} busy={busy} onSave={settings => onSavePolicy(course.id, settings)} />
            </div>
          </details>
        );
      })}
    </div>
  );
}
