import { describe, expect, it } from 'vitest'
import { describeMissingHost, diagnosticLines, electronLaunchOptions, startupStage } from '../apps/desktop/scripts/startup-diagnosis.mjs'

describe('desktop startup diagnosis', () => {
  it('keeps the Windows GUI child hidden when stdio is piped', () => {
    expect(electronLaunchOptions()).toEqual({
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('names a pre-main stall when the hidden console was not used', () => {
    const message = describeMissingHost({
      desktopLog: '(desktop.log was not created: Electron did not enter main.cjs)',
      spawnCode: null,
      exit: null,
      windowsHide: false,
    })
    expect(message).toContain('stage=electron-not-in-main')
    expect(message).toContain('windowsHide=false')
    expect(message).toContain('windowsHide:true')
  })

  it('does not blame the console flag after main was entered', () => {
    const desktopLog = [
      '2026-10-01T15:25:03.000Z app ready',
      '2026-10-01T15:25:03.100Z host spawned pid=12',
    ].join('\n')
    const message = describeMissingHost({
      desktopLog,
      spawnCode: null,
      exit: null,
      windowsHide: true,
    })
    expect(startupStage(desktopLog)).toBe('host spawned pid=12')
    expect(diagnosticLines(desktopLog)).toEqual(['app ready', 'host spawned pid=12'])
    expect(message).toContain('stage=host spawned pid=12')
    expect(message).not.toContain('visible console')
  })

  it('redacts discovery tokens from startup text', () => {
    const message = describeMissingHost({
      desktopLog: '2026-10-01T15:25:03.000Z fatal: denied Bearer secret-token {"token":"abc"}',
      spawnCode: 'ENOENT',
      exit: { code: 1, signal: null },
      windowsHide: true,
    })
    expect(message).toContain('Bearer [redacted]')
    expect(message).toContain('"token":"[redacted]"')
    expect(message).not.toContain('secret-token')
    expect(message).not.toContain('abc')
  })
})
