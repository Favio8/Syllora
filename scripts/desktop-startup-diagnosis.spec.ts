import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeMissingHost, diagnosticEntries, electronLaunchOptions, formatStage, startupStage } from '../apps/desktop/scripts/startup-diagnosis.mjs'

describe('desktop startup diagnosis', () => {
  it('keeps the Windows GUI child hidden when stdio is piped', () => {
    expect(electronLaunchOptions()).toEqual({
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('reports a pre-main stall without treating console visibility as proven', () => {
    const message = describeMissingHost({
      desktopLog: '(desktop.log was not created: Electron did not enter main.cjs)',
      spawnCode: null,
      exit: null,
      windowsHide: false,
      elapsedMs: 20040,
    })
    expect(message).toContain('stage=electron-not-in-main')
    expect(message).toContain('elapsed=20040ms')
    expect(message).toContain('windowsHide=false')
    expect(message).toContain('not isolated')
    expect(message).not.toContain('can stall')
  })

  it('keeps the log timestamp beside the elapsed stage time', () => {
    const desktopLog = [
      '2026-10-01T15:25:03.000Z app ready',
      '2026-10-01T15:25:03.100Z host spawned pid=12',
    ].join('\n')
    const entries = diagnosticEntries(desktopLog)
    expect(startupStage(desktopLog)).toBe('host spawned pid=12')
    expect(formatStage(entries[1], 4100)).toBe('+4100ms 2026-10-01T15:25:03.100Z host spawned pid=12')
    const message = describeMissingHost({
      desktopLog,
      spawnCode: null,
      exit: null,
      windowsHide: true,
      elapsedMs: 4100,
    })
    expect(message).toContain('stage=host spawned pid=12')
    expect(message).toContain('2026-10-01T15:25:03.100Z host spawned pid=12')
  })

  it('redacts discovery tokens and leaves process ids intact', () => {
    const message = describeMissingHost({
      desktopLog: '2026-10-01T15:25:03.000Z fatal: denied Bearer secret-token {"token":"abc"} apiKey=topsecret pid=12',
      spawnCode: 'ENOENT',
      exit: { code: 1, signal: null },
      windowsHide: true,
      elapsedMs: 800,
    })
    expect(message).toContain('Bearer [redacted]')
    expect(message).toContain('"token":"[redacted]"')
    expect(message).toContain('apiKey=[redacted]')
    expect(message).toContain('pid=12')
    expect(message).not.toContain('secret-token')
    expect(message).not.toContain('topsecret')
    expect(message).not.toContain('"abc"')
  })

  it('wires smoke to skip the modal fatal dialog', () => {
    const main = readFileSync(new URL('../apps/desktop/src/main.cjs', import.meta.url), 'utf8')
    const smoke = readFileSync(new URL('../apps/desktop/scripts/smoke-desktop.mjs', import.meta.url), 'utf8')
    const fatalStart = main.indexOf('function fatal')
    const dialogAt = main.indexOf('dialog.showErrorBox', fatalStart)
    const smokeEnvAt = main.indexOf("SYLLORA_DESKTOP_SMOKE === '1'", fatalStart)
    expect(smokeEnvAt).toBeGreaterThan(fatalStart)
    expect(smokeEnvAt).toBeLessThan(dialogAt)
    expect(smoke).toContain("SYLLORA_DESKTOP_SMOKE: '1'")
  })
})
