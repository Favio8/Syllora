/**
 * B7：学习足迹归日不写死 Asia/Shanghai。
 *  - 投影层按「事件所属课程」的时区归日（同一时刻在美国课程里可以是前一天）；
 *  - 原始时间戳（event.at）不改写，归日只发生在展示层；
 *  - 日期轴（recentDays/weekdayOffset）只做纯日历运算，与夏令时边界无关。
 */

import { describe, expect, it } from 'vitest'
import { dayKey, recentDays, weekdayOffset } from '../src/features/workbench/lib/activity'
import { projectWorkspace } from '../src/features/workbench/projection'
import type { SylloraState } from '../src/types/syllora'

describe('B7 activity calendar days', () => {
  it('projects a timestamp in each course timezone without rewriting the timestamp', () => {
    const at = Date.parse('2026-10-02T02:00:00Z')
    const state = { courses: ['Asia/Shanghai', 'America/Los_Angeles'].map((timezone, index) => ({ id: String(index), name: timezone, timezone, next: { text: '' }, points: [], materials: [], messages: [], evidence: {}, revision: null, plan: null })), jobs: [], settings: { consent: false, calls: 0 }, activity: [0, 1].map(index => ({ id: String(index), courseId: String(index), at, kind: 'chat', minutes: 0 })) } as unknown as SylloraState
    const projected = projectWorkspace(state)
    expect(projected.activity!.map(record => record.date)).toEqual(['2026-10-02', '2026-10-01'])
    expect(state.activity!.map(record => record.at)).toEqual([at, at])
  })

  it('uses calendar arithmetic across DST and a Monday-based weekday offset', () => {
    expect(dayKey(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toBe('2026-03-08')
    expect(recentDays(3, '2026-03-09')).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'])
    expect(weekdayOffset('2026-03-09')).toBe(0)
  })
})
