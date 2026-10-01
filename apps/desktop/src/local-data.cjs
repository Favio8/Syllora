'use strict'
const { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } = require('node:fs')
const { constants } = require('node:fs')
const { join, resolve } = require('node:path')

/** Preserve managed originals before publishing the copied legacy snapshot. */
function migrateLegacyData(hostHome, dataDir) {
  const legacy = join(hostHome, 'syllora')
  const source = join(legacy, 'syllora.json')
  const destination = join(dataDir, 'syllora.json')
  if (!existsSync(source) || existsSync(destination)) return false
  if (!lstatSync(source).isFile()) throw new Error('Legacy snapshot must be a regular file')
  mkdirSync(dataDir, { recursive: true })
  const originals = join(legacy, 'files')
  if (existsSync(originals)) {
    if (!lstatSync(originals).isDirectory()) throw new Error('Legacy originals must be a directory')
    const target = join(dataDir, 'files')
    if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error('Originals target must be a directory')
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(originals, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]+\.pdf$/i.test(entry.name)) continue
      const to = join(target, entry.name)
      if (existsSync(to)) continue
      copyFileSync(join(originals, entry.name), to, constants.COPYFILE_EXCL)
    }
  }
  copyFileSync(source, destination, constants.COPYFILE_EXCL)
  return true
}

/** The renderer can reveal known directories, never execute an arbitrary file. */
function managedDirectory(userData, target) {
  if (typeof target !== 'string' || target === '') throw new Error('路径为空')
  const allowed = [join(userData, 'host-home'), join(userData, 'host-home', 'logs'), join(userData, 'syllora-data')].map(resolvePath => resolve(resolvePath))
  const requested = resolve(target)
  if (!allowed.includes(requested)) throw new Error('只允许打开应用数据或日志目录')
  if (!lstatSync(requested).isDirectory()) throw new Error('目标必须是目录')
  if (realpathSync(requested) !== requested) throw new Error('目录不能通过链接指向其他位置')
  return requested
}

module.exports = { migrateLegacyData, managedDirectory }
