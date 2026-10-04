/**
 * R01：新版 Agent 对话（/api/chat/stream）计入主页学习统计。
 *
 * 宿主在回合成功收尾后调用 `chatTurn`，以客户端 requestId 去重：断线重试复用
 * 同一 requestId、幂等重放命中同一回合，都只记一次；不同回合各记一次。
 * 归档课程不计；记账只写 kind:'chat'、minutes:0（互动次数口径，不计时长）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SylloraService } from '../src/syllora.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function serviceWithCourse() {
  const root = await mkdtemp(join(tmpdir(), 'syllora-chat-activity-'))
  roots.push(root)
  const svc = new SylloraService(root)
  const courseId = randomUUID()
  await svc.handle('create', { name: '电路分析基础', requestId: courseId, timezone: 'Asia/Shanghai' })
  return { svc, courseId }
}

async function chatActivity(svc: SylloraService, courseId: string) {
  const state = await svc.handle('state', {}) as { courses: Array<{ id: string; activity?: Array<{ id: string; kind: string; minutes: number; courseId: string }> }> }
  return (state.courses.find(course => course.id === courseId)?.activity ?? []).filter(event => event.kind === 'chat')
}

describe('Agent 对话计入学习统计（R01）', () => {
  it('一次成功回合记一条 chat 互动（0 分钟），state 中可见', async () => {
    const { svc, courseId } = await serviceWithCourse()
    const result = await svc.handle('chatTurn', { courseId, requestId: 'req_a' }) as { recorded: boolean; id: string }
    expect(result.recorded).toBe(true)
    const events = await chatActivity(svc, courseId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'chat:req_a', kind: 'chat', minutes: 0, courseId })
  })

  it('同一 requestId（断线重试/幂等重放）只记一次', async () => {
    const { svc, courseId } = await serviceWithCourse()
    await svc.handle('chatTurn', { courseId, requestId: 'req_retry' })
    const again = await svc.handle('chatTurn', { courseId, requestId: 'req_retry' }) as { recorded: boolean }
    expect(again.recorded).toBe(false)
    expect(await chatActivity(svc, courseId)).toHaveLength(1)
  })

  it('不同回合各记一次', async () => {
    const { svc, courseId } = await serviceWithCourse()
    await svc.handle('chatTurn', { courseId, requestId: 'req_1' })
    await svc.handle('chatTurn', { courseId, requestId: 'req_2' })
    expect(await chatActivity(svc, courseId)).toHaveLength(2)
  })

  it('归档课程不计入', async () => {
    const { svc, courseId } = await serviceWithCourse()
    await svc.handle('archive', { courseId, archived: true })
    const result = await svc.handle('chatTurn', { courseId, requestId: 'req_x' }) as { recorded: boolean; reason?: string }
    expect(result.recorded).toBe(false)
    expect(await chatActivity(svc, courseId)).toHaveLength(0)
  })

  it('入参校验：缺 requestId 或课程 id 非法时拒绝', async () => {
    const { svc, courseId } = await serviceWithCourse()
    await expect(svc.handle('chatTurn', { courseId })).rejects.toThrow()
    await expect(svc.handle('chatTurn', { courseId: 'not-a-uuid', requestId: 'r' })).rejects.toThrow()
  })
})
