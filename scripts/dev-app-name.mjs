import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const require = createRequire(import.meta.url)
const { productName } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const electron = dirname(require.resolve('electron/package.json'))
const dist = join(electron, 'dist')
const original = join(dist, 'Electron.app')
const renamed = join(dist, `${productName}.app`)
const pathFile = join(electron, 'path.txt')
const binary = `${productName}.app/Contents/MacOS/Electron`

if (existsSync(original)) {
  rmSync(renamed, { recursive: true, force: true })
  renameSync(original, renamed)
}
if (!existsSync(renamed)) process.exit(0)

const plist = join(renamed, 'Contents', 'Info.plist')
const buddy = (command) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { encoding: 'utf8' }).trim()

let changed = false
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (buddy(`Print :${key}`) !== productName) {
    buddy(`Set :${key} ${productName}`)
    changed = true
  }
}
if (changed)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', renamed], { stdio: 'ignore' })
if (!existsSync(pathFile) || readFileSync(pathFile, 'utf8') !== binary) {
  writeFileSync(pathFile, binary)
  changed = true
}
execFileSync(
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
  ['-f', renamed],
  { stdio: 'ignore' },
)
if (changed) console.log(`Dev Electron app is now ${productName}.app`)
