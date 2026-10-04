import { describe, expect, it } from 'vitest'
import { dispatch, type HostServices } from '../src/index.ts'
import { CloudError } from '../../chat-service/src/syllora-cloud.ts'

describe('cloud connection diagnostics', () => {
  it.each([
    [new CloudError('ACCESS_CODE=fixture-secret', 401, 'UNAUTHORIZED'), 'CLOUD_UNAUTHORIZED', '访问口令'],
    [new CloudError('https://fixture-secret.invalid', undefined, 'UNREACHABLE'), 'CLOUD_UNREACHABLE', '服务地址'],
    [new CloudError('fixture-secret', undefined, 'TIMEOUT'), 'CLOUD_TIMEOUT', '连接检测超时'],
    [new Error('credentials path /fixture-secret/config.yaml'), 'CLOUD_GENERATION_FAILED', '无法检测云端课堂连接'],
  ])('returns actionable, sanitized diagnostics for %s', async (error, reason, message) => {
    const services = { classroomService: { capabilities: async () => { throw error } } } as unknown as HostServices
    const result = await dispatch('classroom.capabilities', {}, services)
    expect(result).toMatchObject({ ok: false, error: { code: 'cloud-connection-failed', message: expect.stringContaining(message as string), details: { reason } } })
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    expect(JSON.stringify(result)).not.toContain('详见宿主日志')
  })
})
