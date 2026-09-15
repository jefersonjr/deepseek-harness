/** Interpreter selection with command files for Windows cmd quoting. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Owned command resources, released only after the subprocess settles. */
export interface PreparedShellCommand extends Disposable {
  /** Executable and arguments; command text is never re-escaped as a Windows argv value. */
  argv: string[]
}

/**
 * Prepare one shell invocation; cmd receives UTF-8 batch source through a private temporary file.
 * @param command - source written by the model for the selected interpreter.
 * @param shell - interpreter dialect.
 * @returns invocation and deterministic cleanup for its temporary resources.
 */
export function prepareShellCommand(command: string, shell: 'bash' | 'cmd'): PreparedShellCommand {
  if (shell === 'bash') return { argv: ['bash', '-c', command], [Symbol.dispose]() {} }
  if (process.platform !== 'win32') throw new Error('cmd requires a Windows host')
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cmd-'))
  const path = join(directory, 'command.cmd')
  try {
    writeFileSync(path, `@echo off\r\n@chcp 65001 >nul\r\n${command.replace(/\r?\n/g, '\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    argv: [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), '/d', '/s', '/c', path],
    [Symbol.dispose]() { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) },
  }
}
