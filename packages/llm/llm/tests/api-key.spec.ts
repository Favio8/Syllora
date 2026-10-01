import { describe, expect, it } from 'vitest'
import { assertUsableApiKey, INVALID_CREDENTIAL_CODE, normalizeApiKey } from '@deepseek-ai/dsh-llm'

/** Fixture value standing in for a key: printable ASCII, no provider's shape. */
const PLACEHOLDER = 'placeholder-value'
/** Base token for the rejection cases; the rejected character is appended to it. */
const INVALID_PREFIX = 'placeholder'

describe('normalizeApiKey', () => {
  it('accepts a printable-ASCII key unchanged', () => {
    expect(normalizeApiKey(PLACEHOLDER)).toEqual({ ok: true, value: PLACEHOLDER })
  })

  it('trims surrounding whitespace before judging', () => {
    expect(normalizeApiKey('  ' + PLACEHOLDER + '\t\n')).toEqual({ ok: true, value: PLACEHOLDER })
  })

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab only', '\t'],
  ])('rejects %s as empty', (_label, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'empty' })
  })

  it.each([
    ['an emoji', INVALID_PREFIX + '\u{1F600}abc'],
    ['CJK text', INVALID_PREFIX + '你好'],
    ['full-width punctuation', INVALID_PREFIX + '，'],
    ['an interior space', INVALID_PREFIX + ' def'],
    ['a C0 control character', INVALID_PREFIX + '\x01'],
    ['a latin-1 character', INVALID_PREFIX + '-café'],
  ])('rejects %s as illegal characters', (_label, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'illegalCharacters' })
  })

  it('accepts the printable-ASCII boundary characters', () => {
    expect(normalizeApiKey('!~')).toEqual({ ok: true, value: '!~' })
  })

  it('publishes a code distinct from a missing credential', () => {
    expect(INVALID_CREDENTIAL_CODE).toBe('INVALID_CREDENTIAL')
  })
})

describe('assertUsableApiKey', () => {
  it('returns the trimmed key when it is usable', () => {
    expect(assertUsableApiKey('  ' + PLACEHOLDER + '  ', 'llm-deepseek', 'DEEPSEEK_API_KEY')).toBe(PLACEHOLDER)
  })

  it('refuses a blank stored credential, naming the reference', () => {
    expect(() => assertUsableApiKey('   ', 'llm-deepseek', 'DEEPSEEK_API_KEY'))
      .toThrow(/llm-deepseek: the API key resolved from DEEPSEEK_API_KEY is blank/)
  })

  it('refuses an unusable stored credential with the invalid-credential code', () => {
    try {
      assertUsableApiKey(INVALID_PREFIX + '\u{1F600}', 'llm-pi-ai', 'ACME_API_KEY')
      expect.fail('an illegal key must throw')
    } catch (error) {
      expect((error as { code: string }).code).toBe(INVALID_CREDENTIAL_CODE)
      expect((error as Error).message).toContain('llm-pi-ai')
      expect((error as Error).message).toContain('ACME_API_KEY')
    }
  })

  it('never echoes the key it refuses', () => {
    try {
      assertUsableApiKey(INVALID_PREFIX + '\u{1F600}supersecret', 'llm-deepseek', 'DEEPSEEK_API_KEY')
      expect.fail('an illegal key must throw')
    } catch (error) {
      expect((error as Error).message).not.toContain('supersecret')
    }
  })
})
