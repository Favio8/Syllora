import { describe, expect, it } from 'vitest'
import { editDraft, hydrateCourse, markSaved, rememberServer, type DraftCache } from '../src/components/syllora-drafts'

describe('course draft cache', () => {
  it('keeps a newer local draft when the polled server copy is stale', () => {
    let cache: DraftCache = {}
    cache = rememberServer(cache, 'a', { prompt: '', answers: [] })
    cache = editDraft(cache, 'a', '还没发送', { q: 2 })
    cache = rememberServer(cache, 'a', { prompt: '', answers: [] })
    const view = hydrateCourse(cache, 'a', { prompt: '', answers: [] })
    expect(view.prompt).toBe('还没发送')
    expect(view.answers).toEqual({ q: 2 })
    expect(view.shouldSave).toBe(false)
  })

  it('accepts a server draft only when the local copy has been saved', () => {
    let cache: DraftCache = editDraft({}, 'b', '旧草稿', {})
    cache = { ...cache, b: { ...cache.b!, savedRevision: cache.b!.revision } }
    cache = rememberServer(cache, 'b', { prompt: '服务器上的草稿', answers: [{ questionId: 'q', option: 1 }] })
    expect(hydrateCourse(cache, 'b', { prompt: '服务器上的草稿', answers: [{ questionId: 'q', option: 1 }] }).prompt).toBe('服务器上的草稿')
  })

  it('keeps a saved draft when an earlier empty poll returns later', () => {
    let cache = markSaved(editDraft({}, 'a', '刚保存的问题', { q: 1 }), 'a', 1, 500)
    cache = rememberServer(cache, 'a', { prompt: '', answers: [] }, 100)
    expect(cache.a?.prompt).toBe('刚保存的问题')
    expect(cache.a?.answers).toEqual({ q: 1 })
    cache = rememberServer(cache, 'a', { prompt: '服务器上的新草稿', answers: [] }, 600)
    expect(cache.a?.prompt).toBe('服务器上的新草稿')
  })
})
