/**
 * B7：学习足迹按「日」归并时不再写死 Asia/Shanghai。
 *  - `dayKey(date, timeZone)`：把时刻换算成某个时区的日历日（YYYY-MM-DD）。
 *    时区缺省取浏览器所在时区，取不到时才回落到 Asia/Shanghai。
 *  - `recentDays`：日期轴只做纯日历运算（UTC 零点上加减天数），与任何时区、
 *    夏令时都无关——旧实现用 `T12:00:00+08:00` 起算再按上海时区格式化，
 *    换成其他时区后边界日会错位。
 * 原始时间戳（event.at）不改写；归日只发生在展示投影层。
 */
export const FALLBACK_TIME_ZONE = 'Asia/Shanghai';

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE; }
  catch { return FALLBACK_TIME_ZONE; }
}

export function dayKey(date: Date | number = new Date(), timeZone: string = localTimeZone()): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    // 非法时区名（旧数据）：回落到浏览器时区，而不是抛错让首页白屏。
    return new Intl.DateTimeFormat('sv-SE', { timeZone: localTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
}

/** 以 `today`（YYYY-MM-DD）为最后一天，向前取 count 个日历日。 */
export function recentDays(count: number, today = dayKey()): string[] {
  const end = new Date(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - count + 1 + i);
    return date.toISOString().slice(0, 10);
  });
}

/** 周一为 0 的星期偏移（热力图首列补位用），同样不依赖时区。 */
export function weekdayOffset(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}
