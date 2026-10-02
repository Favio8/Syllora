import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Desktop smoke launch options and failure text.
 *
 * Job 110406638882 waited 20s with empty Electron stdout and no host.json while
 * windowsHide was false. Job 110442030725 later wrote host.json in about 4s
 * with windowsHide true, but that commit also changed naming, diagnostics, and
 * paths. The console flag is therefore not an isolated cause. Smoke still hides
 * the GUI console because piped stdio needs it on Windows CI, and it records
 * stage timestamps instead of treating a longer wait as the fix.
 */

export function electronLaunchOptions() {
  return {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
}

export function redactSecrets(text) {
  return String(text)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/("(?:token|access_token|apiKey|api_key|secret|password)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/\b((?:token|access_token|apiKey|api_key|secret|password)\s*[:=]\s*)\S+/gi, '$1[redacted]')
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/

export function diagnosticEntries(desktopLog) {
  if (!desktopLog || desktopLog.startsWith('(desktop.log was not created')) return []
  return redactSecrets(desktopLog)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = STAMP.exec(line)
      const message = (match ? match[2] : line).slice(0, 240)
      return { at: match ? match[1] : null, message }
    })
}

export function diagnosticLines(desktopLog) {
  return diagnosticEntries(desktopLog).map(entry => entry.message)
}

export function startupStage(desktopLog) {
  return diagnosticLines(desktopLog).at(-1) ?? 'electron-not-in-main'
}

export function formatStage(entry, elapsedMs) {
  const elapsed = Number.isFinite(elapsedMs) ? `+${Math.max(0, Math.round(elapsedMs))}ms` : '+?ms'
  return entry.at ? `${elapsed} ${entry.at} ${entry.message}` : `${elapsed} ${entry.message}`
}

export function describeMissingHost({ desktopLog, spawnCode, exit, windowsHide, elapsedMs }) {
  const stage = startupStage(desktopLog)
  const elapsed = Number.isFinite(elapsedMs) ? `${Math.max(0, Math.round(elapsedMs))}ms` : 'unknown'
  const lines = [
    `host.json not found; stage=${stage}; elapsed=${elapsed}; spawn=${spawnCode ?? 'ok'}; exit=${JSON.stringify(exit)}; windowsHide=${windowsHide === true}`,
  ]
  if (stage === 'electron-not-in-main') {
    lines.push('Electron did not enter main.cjs before the wait ended, so desktop.log has no stage. Spawn and exit above are the process result. Console visibility was not isolated as the cause.')
  } else if (stage.startsWith('fatal:')) {
    lines.push('Electron reached main.cjs and stopped with a startup fatal. The stage above is the recorded reason.')
  }
  if (desktopLog) lines.push(redactSecrets(desktopLog))
  return lines.join('\n')
}

/** Read only bounded, redacted logs from the smoke's fresh synthetic userData. */
export function collectHostStartupEvidence(userData) {
  const home = join(userData, 'host-home')
  const logDir = join(home, 'logs')
  const evidence = {
    homeCreated: existsSync(home),
    instanceLockCreated: existsSync(join(home, 'host.lock')),
    discoveryCreated: existsSync(join(home, 'host.json')),
    logs: [],
  }
  try {
    for (const name of readdirSync(logDir).filter(name => /^host-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort().slice(-2)) {
      const path = join(logDir, name)
      const info = lstatSync(path)
      if (!info.isFile()) continue
      const text = info.size <= 1024 * 1024 ? redactSecrets(readFileSync(path, 'utf8')).slice(-16000) : '[omitted: log exceeds 1 MiB]'
      evidence.logs.push({ name, text })
    }
  } catch { /* The host may have failed before creating its log directory. */ }
  return evidence
}
