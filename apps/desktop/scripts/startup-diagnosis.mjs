/**
 * Desktop smoke launch contract and failure text.
 *
 * Windows CI job 110406638882 (commit 913c020) spawned electron.exe with piped
 * stdio and windowsHide:false. The step printed nothing after the userData path
 * and host.json was still missing at 20s. The same runner class with
 * windowsHide:true (job 110442030725) wrote host.json in about 4s. An interactive
 * desktop can pass either way, so the hidden console is required for CI rather
 * than a cosmetic flag. Do not treat a longer wait as the fix.
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
    .replace(/("token"\s*:\s*")[^"]*/gi, '$1[redacted]')
}

export function diagnosticLines(desktopLog) {
  if (!desktopLog || desktopLog.startsWith('(desktop.log was not created')) return []
  return redactSecrets(desktopLog)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '').slice(0, 240))
}

export function startupStage(desktopLog) {
  const lines = diagnosticLines(desktopLog)
  return lines.at(-1) ?? 'electron-not-in-main'
}

export function describeMissingHost({ desktopLog, spawnCode, exit, windowsHide }) {
  const stage = startupStage(desktopLog)
  const lines = [
    `host.json not found; stage=${stage}; spawn=${spawnCode ?? 'ok'}; exit=${JSON.stringify(exit)}; windowsHide=${windowsHide === true}`,
  ]
  if (stage === 'electron-not-in-main' && windowsHide !== true) {
    lines.push('Electron did not enter main.cjs. On Windows, piped stdio plus a visible console can stall the GUI process before desktop.log exists; launch with windowsHide:true.')
  } else if (stage === 'electron-not-in-main') {
    lines.push('Electron did not enter main.cjs. The binary was missing, the process stalled before the first diagnostic line, or it crashed without reaching main.')
  } else if (stage.startsWith('fatal:')) {
    lines.push('Electron reached main.cjs and stopped with a startup fatal. The stage above is the reason; host.json is not expected after that.')
  }
  if (desktopLog) lines.push(redactSecrets(desktopLog))
  return lines.join('\n')
}
