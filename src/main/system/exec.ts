import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const fallbackDirs = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]

let resolvedPath: Promise<string> | undefined

function loginShellPath() {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise<string>((resolve) => {
    execFile(
      shell,
      ['-ilc', 'printf "__PRISM_PATH__%s__PRISM_PATH__" "$PATH"'],
      { timeout: 5000, encoding: 'utf8' },
      (_error, stdout) => resolve(/__PRISM_PATH__(.*)__PRISM_PATH__/.exec(stdout ?? '')?.[1] ?? ''),
    )
  })
}

export function userPath() {
  resolvedPath ??= loginShellPath().then((shellPath) => {
    const parts = [shellPath, process.env.PATH ?? '', fallbackDirs.join(delimiter)]
      .flatMap((value) => value.split(delimiter))
      .filter(Boolean)
    return [...new Set(parts)].join(delimiter)
  })
  return resolvedPath
}

export async function userEnv(extra: Record<string, string> = {}) {
  return { ...process.env, PATH: await userPath(), ...extra }
}

export type RunResult = { code: number; stdout: string; stderr: string }

export async function run(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const env = await userEnv(options.env)
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd: options.cwd, env, timeout: options.timeout ?? 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === 'number'
            ? Number((error as NodeJS.ErrnoException).code)
            : error
              ? 1
              : 0
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (error ? error.message : ''),
        })
      },
    )
    child.stdin?.end()
  })
}

export async function which(bin: string) {
  const result = await run('/usr/bin/which', [bin], { timeout: 5000 })
  return result.code === 0 ? result.stdout.trim() || null : null
}

export async function runStreaming(
  command: string,
  options: { cwd: string; onData: (chunk: string) => void; timeout?: number },
) {
  const env = await userEnv()
  return new Promise<number>((resolve) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], {
      cwd: options.cwd,
      env,
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 10 * 60_000)
    child.stdout.on('data', (data: Buffer) => options.onData(data.toString()))
    child.stderr.on('data', (data: Buffer) => options.onData(data.toString()))
    child.on('error', (error) => {
      options.onData(`${error.message}\n`)
      clearTimeout(timer)
      resolve(1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}
