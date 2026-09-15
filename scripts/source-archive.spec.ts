/** Source-archive setup must not execute Git, even when Git metadata is present. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []
const buildEnvironment = new URL('./client-build-environment.ts', import.meta.url).href
const installer = new URL('./install-lefthook.mjs', import.meta.url).href
const tsxLoader = import.meta.resolve('tsx/esm')

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('source archive setup', () => {
  for (const withMetadata of [false, true]) {
    it(`builds version metadata and skips hooks ${withMetadata ? 'with' : 'without'} a .git directory`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'dsh-source-archive-'))
      fixtures.push(fixture)
      writeFileSync(join(fixture, 'package.json'), '{"version":"2.3.4"}\n')
      if (withMetadata) mkdirSync(join(fixture, '.git'))

      // Patch only the owned child; any subprocess attempt fails the setup.
      const source = `
        import childProcess from 'node:child_process'
        import { syncBuiltinESMExports } from 'node:module'
        const forbidden = () => { throw new Error('source archive attempted a subprocess') }
        childProcess.spawnSync = forbidden
        childProcess.execFileSync = forbidden
        syncBuiltinESMExports()
        const { repositoryClientBuildEnvironment, resolveClientBuildEnvironment } = await import(${JSON.stringify(buildEnvironment)})
        const environment = repositoryClientBuildEnvironment(process.cwd(), process.env)
        try {
          resolveClientBuildEnvironment(environment, 'official')
          throw new Error('archive accepted as an official build')
        } catch (error) {
          if (!error.message.includes('DSH_CLIENT_COMMIT_HASH is required')) throw error
        }
        await import(${JSON.stringify(installer)})
        console.log(JSON.stringify(environment))
      `
      const result = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '--eval', source], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          CI: 'false',
          GITHUB_ACTIONS: 'false',
          DSH_SOURCE_ARCHIVE: '1',
          DSH_CLIENT_COMMIT_HASH: '0123456789abcdef',
          DSH_CLIENT_GIT_DIRTY: 'true',
          DSH_CLIENT_VERSION: 'stale',
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const environment = JSON.parse(result.stdout) as Record<string, string>
      expect(environment.DSH_CLIENT_VERSION).toBe('2.3.4')
      expect(environment.DSH_CLIENT_COMMIT_HASH).toBeUndefined()
      expect(environment.DSH_CLIENT_GIT_DIRTY).toBeUndefined()
      expect(environment.DSH_SOURCE_ARCHIVE).toBeUndefined()
    })
  }
})
