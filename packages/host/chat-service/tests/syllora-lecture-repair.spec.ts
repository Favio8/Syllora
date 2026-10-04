import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { lectureSchema, repairLecture, validateLecture } from '../src/syllora-initialize.ts'
import type { Source } from '../src/syllora-domain.ts'

type Lecture = z.infer<typeof lectureSchema>
const source = (id: string, text: string): Source => ({ id, materialId: 'fixture-material', anchor: `${id}.txt`, text })
const lecture = (overrides: Partial<Lecture> = {}): Lecture => lectureSchema.parse({
  chapter: 'Fixture chapter',
  intro: { text: 'Introduction', sourceIds: ['source-1'] },
  concepts: [{ name: 'Concept', text: 'Explanation', quote: 'Alpha beta fact', sourceIds: ['source-1'] }],
  examples: [], connections: [], analogies: [], ...overrides,
})

describe('lecture quote validation and repair', () => {
  it.each([
    ['HTML', 'Alpha beta fact appears here.', '<p>Alpha <strong>beta</strong> fact appears here.</p>'],
    ['markdown', '**Alpha beta** fact appears here.', 'Alpha beta fact appears here.'],
    ['inline code', 'Alpha beta uses `fact` here.', 'Alpha beta uses fact here.'],
    ['whitespace', 'Alpha beta\n\n uses   fact here.', 'Alpha beta uses fact here.'],
    ['entities', 'Alpha &amp; beta fact appears here.', 'Alpha & beta fact appears here.'],
  ])('accepts substantive %s formatting differences', (_name, text, quote) => {
    const sources = [source('source-1', text!)]
    const value = lecture({ concepts: [{ name: 'Concept', text: 'Explanation', quote: quote!, sourceIds: ['source-1'] }] })
    expect(() => validateLecture(value, sources)).not.toThrow()
    expect(() => validateLecture(repairLecture(value, sources), sources)).not.toThrow()
  })

  it.each(['<br><br>', '<p>   \n\t </p>'])('rejects empty normalized evidence even when it occurs verbatim: %s', quote => {
    const sources = [source('source-1', `Before ${quote} after.`)]
    const value = lecture({ concepts: [{ name: 'Concept', text: 'Explanation', quote, sourceIds: ['source-1'] }] })
    expect(() => validateLecture(value, sources)).toThrow('讲义依据不是资料原文')
    expect(() => repairLecture(value, sources)).toThrow('讲义依据不是资料原文')
  })

  it('preserves mathematical symbols and rejects changed formula evidence', () => {
    const quote = 'The invariant is ∑_{i=1}^n x_i = x_1 + x_2.'
    const sources = [source('source-1', quote)]
    const value = lecture({ concepts: [{ name: 'Formula', text: 'Explanation', quote, sourceIds: ['source-1'] }] })
    expect(() => validateLecture(value, sources)).not.toThrow()
    expect(repairLecture(value, sources).concepts[0]!.quote).toBe(quote)
    value.concepts[0]!.quote = quote.replace('x_2', 'x_3')
    expect(() => validateLecture(value, sources)).toThrow('讲义依据不是资料原文')
  })

  it('removes duplicate, unknown and unrelated citations and reanchors actual evidence', () => {
    const sources = [source('source-1', 'Alpha beta fact appears here.'), source('source-2', 'An unrelated topic appears here.')]
    // 导读引用两个片段：修整只清理引用，不替模型补覆盖（下方严格覆盖用例断言了这一点）。
    const value = lecture({ intro: { text: 'Introduction', sourceIds: ['source-1', 'source-2'] }, concepts: [
      { name: 'First', text: 'Explanation', quote: 'Alpha beta fact', sourceIds: ['source-1', 'source-2', 'source-1', 'unknown'] },
      { name: 'Second', text: 'Explanation', quote: 'Alpha beta fact', sourceIds: ['source-2'] },
    ] })
    const repaired = repairLecture(value, sources)
    expect(repaired.concepts.map(item => item.sourceIds)).toEqual([['source-1'], ['source-1']])
    expect(() => validateLecture(repaired, sources)).not.toThrow()
    expect(value.concepts[0]!.sourceIds).toEqual(['source-1', 'source-2', 'source-1', 'unknown'])
  })

  it('drops unsupported items without fabricating coverage', () => {
    const sources = [source('source-1', 'Alpha beta fact appears here.'), source('source-2', 'The second fragment needs coverage.')]
    const value = lecture({
      concepts: [...lecture().concepts, { name: 'Unsupported', text: 'Explanation', quote: 'Invented evidence only.', sourceIds: ['source-2'] }],
      examples: [{ title: 'Unsupported', text: 'Explanation', quote: 'Invented example evidence.', sourceIds: ['source-2'] }],
      connections: [{ text: 'Connection', sourceIds: ['source-1', 'unknown', 'source-1'] }, { text: 'Unsupported', sourceIds: ['unknown'] }],
      analogies: [{ text: 'Unsupported', sourceIds: ['unknown'] }],
    })
    const repaired = repairLecture(value, sources)
    expect(repaired.concepts).toHaveLength(1)
    expect(repaired.examples).toEqual([])
    expect(repaired.connections).toEqual([{ text: 'Connection', sourceIds: ['source-1'] }])
    expect(repaired.analogies).toEqual([])
    expect(repaired.intro.sourceIds).toEqual(['source-1'])
    expect(() => validateLecture(repaired, sources)).toThrow('本批资料没有完整关联到讲义，请重试')
  })

  it('throws when all concepts lack grounded evidence', () => {
    expect(() => repairLecture(lecture(), [source('source-1', 'Only unrelated text is available.')])).toThrow('讲义依据不是资料原文')
  })

  it.each([
    'The catalyst does not increase reaction speed under heat.',
    'If the catalyst increases reaction speed under heat, the outcome changes.',
    'Under heat, reaction speed increases the catalyst.',
  ])('never fuzzy-grounds negated, conditional or reordered evidence: %s', quote => {
    const sources = [source('source-1', 'The catalyst increases reaction speed under heat.')]
    const value = lecture({ concepts: [
      { name: 'Supported', text: 'Explanation', quote: sources[0]!.text, sourceIds: ['source-1'] },
      { name: 'Rewrite', text: 'Explanation', quote, sourceIds: ['source-1'] },
    ] })
    expect(() => validateLecture(value, sources)).toThrow('讲义依据不是资料原文')
    expect(repairLecture(value, sources).concepts.map(item => item.name)).toEqual(['Supported'])
  })

  it('strictly rejects uncovered sources after citation repair', () => {
    const sources = [source('source-1', 'Alpha beta fact appears here.'), source('source-2', 'A second source completes coverage.')]
    const incomplete = lecture()
    expect(() => validateLecture(incomplete, sources)).toThrow('本批资料没有完整关联到讲义，请重试')
    const value = lecture({ intro: { text: 'Introduction', sourceIds: ['source-1', 'unknown', 'source-1'] } })
    expect(() => validateLecture(value, sources)).toThrow('讲义引用了未提供的来源')
    const repaired = repairLecture(value, sources)
    expect(repaired.intro.sourceIds).toEqual(['source-1'])
    expect(() => validateLecture(repaired, sources)).toThrow('本批资料没有完整关联到讲义，请重试')
    expect(() => validateLecture(incomplete, sources)).toThrow('本批资料没有完整关联到讲义，请重试')
  })

  it('does not add uncovered sources after surviving lecture items are considered', () => {
    const sources = [source('source-1', 'Alpha beta fact'), source('source-2', 'Example beta fact'), source('source-3', 'Connection'), source('source-4', 'Analogy'), source('source-5', 'Remaining fragment')]
    const value = lecture({
      intro: { text: 'Introduction', sourceIds: ['unknown'] },
      examples: [{ title: 'Example', text: 'Explanation', quote: 'Example beta fact', sourceIds: ['source-2'] }],
      connections: [{ text: 'Connection', sourceIds: ['source-3'] }],
      analogies: [{ text: 'Analogy', sourceIds: ['source-4'] }],
    })
    const repaired = repairLecture(value, sources)
    expect(repaired.intro.sourceIds).toEqual([])
    expect(() => validateLecture(repaired, sources)).toThrow('本批资料没有完整关联到讲义，请重试')
  })
})
