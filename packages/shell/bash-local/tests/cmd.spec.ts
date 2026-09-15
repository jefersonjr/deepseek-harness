import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '../src/index.ts'
import type { PreparedShellCommand } from '../src/command.ts'
import { prepareShellCommand } from '../src/command.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
})

class TrackedCmdExecutor extends LocalBashExecutor {
  readonly files: string[] = []
  protected override prepareCommand(command: string): PreparedShellCommand {
    const prepared = super.prepareCommand(command)
    this.files.push(prepared.argv.at(-1)!)
    return prepared
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh cmd workspace '))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(TrackedCmdExecutor, { shell: 'cmd', cwd: root })
  return { ctx, root, shell: ctx.shell as TrackedCmdExecutor }
}

describe.skipIf(process.platform !== 'win32')('Windows cmd executor', () => {
  it('runs quoted commands, paths with spaces and Unicode through cmd', async () => {
    const { root, shell } = await setup()
    const result = await shell.run(shell.resolve({
      command: 'echo ação\r\nnode -e "require(\'node:fs\').writeFileSync(\'résumé file.txt\', \'ação😀\')"',
    }))
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
    expect(result.stdout.text).toContain('ação')
    expect(readFileSync(join(root, 'résumé file.txt'), 'utf8')).toBe('ação😀')
    expect(shell.files.every(path => !existsSync(path))).toBe(true)
    expect(shell.dialect).toBe('cmd')
  })

  it('preserves native exit codes and batch variable expansion', async () => {
    const { shell } = await setup()
    const result = await shell.run(shell.resolve({ command: 'set DSH_CMD_TEST=ready\r\necho %DSH_CMD_TEST%\r\nexit /b 7' }))
    expect(result).toMatchObject({ exitCode: 7, timedOut: false, aborted: false })
    expect(result.stdout.text).toContain('ready')
  })

  it('executes the temporary batch file through the Windows sandbox runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh cmd confined '))
    const temporary = mkdtempSync(join(tmpdir(), 'dsh cmd private '))
    roots.push(root, temporary)
    const output = join(root, 'ação file.txt')
    using command = prepareShellCommand(`echo ação>"${output}"`, 'cmd')
    const runner = fileURLToPath(new URL('../../../sandbox/sandbox-windows-acl/src/runner.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', runner, '--workspace', root, '--temp', temporary, '--mode', 'workspace-write', '--', ...command.argv], { encoding: 'utf8', timeout: 30000 })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(output, 'utf8').trim()).toBe('ação')
  })

  it('keeps background command files until cancellation settles and then removes them', async () => {
    const { shell } = await setup()
    const abort = new AbortController()
    const proc = shell.start(shell.resolve({
      command: 'node -e "process.stdout.write(\'ready\');setInterval(()=>{},1000)"',
      signal: abort.signal,
    }))
    let output = ''
    await vi.waitFor(() => { output += proc.readOutput().delta; expect(output).toContain('ready') })
    expect(shell.files.every(existsSync)).toBe(true)
    abort.abort()
    await proc.done
    expect(proc.status).toBe('killed')
    expect(shell.files.every(path => !existsSync(path))).toBe(true)
  })
})
