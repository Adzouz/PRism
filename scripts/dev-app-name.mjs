import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

if (process.platform !== 'darwin') process.exit(0)

const require = createRequire(import.meta.url)
const { productName } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const app = join(dirname(require.resolve('electron/package.json')), 'dist', 'Electron.app')
const plist = join(app, 'Contents', 'Info.plist')
if (!existsSync(plist)) process.exit(0)

const buddy = (command) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { encoding: 'utf8' }).trim()

if (
  buddy('Print :CFBundleName') === productName &&
  buddy('Print :CFBundleDisplayName') === productName
) {
  process.exit(0)
}
buddy(`Set :CFBundleName ${productName}`)
buddy(`Set :CFBundleDisplayName ${productName}`)
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
console.log(`Dev Electron app renamed to ${productName}`)
