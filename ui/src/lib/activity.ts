import type { LearningRecord } from '@/types';

export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function recentDays(count: number, today = dayKey()) {
  const end = new Date(`${today}T12:00:00+08:00`);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - count + 1 + i);
    return dayKey(date);
  });
}

/** Example history is explicitly tagged; current UI interactions create untagged records. */
export function demoActivity(): LearningRecord[] {
  const courseIds = ['linear-algebra', 'probability', 'python'];
  return recentDays(84).flatMap((date, i) => {
    const count = [1, 2, 0, 3, 2, 0, 1, 3, 0, 2, 1, 2][i % 12];
    return Array.from({ length: count }, (_, j) => ({ id: `demo-${date}-${j}`, date, courseId: courseIds[(i + j) % 3], kind: 'task' as const, minutes: [10, 15, 20, 25][(i + j) % 4], demo: true }));
  });
}
