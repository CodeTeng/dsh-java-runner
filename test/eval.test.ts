import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanJshellOutput, extractErrors, jshellArgv } from '../src/eval.js'
import type { Harness } from './helpers/harness.js'
import { createHarness } from './helpers/harness.js'

interface EvalValue {
  success: boolean
  timedOut: boolean
  exitCode: number | null
  durationMs: number
  jshell: string
  stdout: string
  stderr: string
  errors: string[]
  classpath: string[]
  workdir: string | null
  scriptPath: string | null
  retained: boolean
  retainedReason: string | null
  stdoutTruncated: boolean
  stderrTruncated: boolean
  sandbox: { mode: string; enforcement: string } | null
}

let harness: Harness | undefined

afterEach(async () => {
  if (harness) {
    await harness.dispose()
    harness = undefined
  }
})

async function execute(args: unknown): Promise<EvalValue> {
  if (harness === undefined) throw new Error('harness is not initialized')
  const result = await harness.execute('java_eval', args)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('java_eval returned a tool error')
  return result.value as unknown as EvalValue
}

describe('jshell output handling', () => {
  it('strips prompts, CRLF, and the welcome banner', () => {
    const text = [
      '|  Welcome to JShell -- Version 17.0.9',
      '|  For an introduction type: /help intro',
      '',
      'hello\r',
      'jshell> ',
    ].join('\n')

    expect(cleanJshellOutput(text)).toBe('\nhello')
  })

  it('extracts compile errors and exceptions without stack frames', () => {
    const stderr = [
      'Error:',
      'illegal start of expression',
      'int y = ;',
      '        ^',
      'Exception java.lang.RuntimeException: boom',
      '      at (#4:1)',
    ].join('\r\n')

    expect(extractErrors(stderr)).toEqual([
      'Error:',
      'Exception java.lang.RuntimeException: boom',
    ])
  })

  it('builds argv with English, UTF-8, heap, and classpath options', () => {
    const argv = jshellArgv('/jdk/bin/jshell', {
      scriptPath: '/work/snippet.jsh',
      classpath: ['/lib/a.jar', '/lib/b.jar'],
      maxHeapMb: 128,
    })

    expect(argv.slice(0, 3)).toEqual(['/jdk/bin/jshell', '--feedback', 'concise'])
    expect(argv).toContain('-J-Xmx128m')
    expect(argv).toContain('-R-Xmx128m')
    expect(argv).toContain('-J-Duser.language=en')
    expect(argv).toContain('-R-Duser.language=en')
    expect(argv).toContain('-R-Dsun.stdout.encoding=UTF-8')
    expect(argv).toContain('--class-path')
    expect(argv.at(-1)).toBe('/work/snippet.jsh')
  })
})

describe('java_eval', () => {
  it('registers alongside the other Java tools', async () => {
    harness = await createHarness()
    expect(harness.ctx.tools.get('java_eval')?.name).toBe('java_eval')
  })

  it('runs a snippet and cleans the JShell output', async () => {
    harness = await createHarness()
    let script = ''
    harness.fake.handler = async (call) => {
      if (call.kind !== 'jshell') return undefined
      const path = call.spec.argv.at(-1)
      script = path === undefined ? '' : await readFile(path, 'utf8')
      return { stdout: 'hello\r\njshell> ', exitCode: 0 }
    }

    const value = await execute({ code: 'System.out.println("hello");' })

    expect(value.success).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('hello')
    expect(value.errors).toEqual([])
    expect(value.retained).toBe(false)
    expect(value.workdir).toBeNull()
    expect(value.scriptPath).toBeNull()
    expect(value.jshell.endsWith(process.platform === 'win32' ? 'jshell.exe' : 'jshell')).toBe(true)
    expect(script).toBe('System.out.println("hello");\n')

    const call = harness.fake.callsOf('jshell')[0]
    expect(call?.spec.cwd).toBe(harness.workspace)
    expect(call?.spec.argv).toContain('-J-Xmx64m')
    expect(call?.spec.argv).toContain('-R-Dstdout.encoding=UTF-8')
    expect(call?.spec.env?.['JAVA_HOME']).toBe(harness.fake.home)
  })

  it('fails when JShell reports a compile error or exception', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) =>
      call.kind === 'jshell'
        ? {
            stdout: 'after\r\njshell> ',
            stderr:
              'Error:\r\nillegal start of expression\r\nint y = ;\r\n        ^\r\nException java.lang.RuntimeException: boom\r\n      at (#4:1)\r\n',
            exitCode: 0,
          }
        : undefined

    const value = await execute({ code: 'int y = ;' })

    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(0)
    expect(value.errors).toEqual([
      'Error:',
      'Exception java.lang.RuntimeException: boom',
    ])
    expect(value.stdout).toBe('after')
    expect(value.retained).toBe(true)
    expect(value.retainedReason).toBe('the call did not succeed')
    expect(value.workdir).not.toBeNull()
    expect(value.scriptPath).toBe(join(value.workdir!, 'snippet.jsh'))
  })

  it('resolves relative classpath entries against the workspace', async () => {
    harness = await createHarness()

    const value = await execute({
      code: 'System.out.println("ok");',
      classpath: ['lib/foo.jar'],
    })

    expect(value.classpath).toEqual([join(harness.workspace, 'lib', 'foo.jar')])
    const call = harness.fake.callsOf('jshell')[0]
    expect(call?.spec.argv).toContain(join(harness.workspace, 'lib', 'foo.jar'))
  })

  it('terminates JShell on timeout and keeps the script', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) =>
      call.kind === 'jshell' ? { exitCode: 0, delayMs: 5000 } : undefined

    const value = await execute({ code: 'while (true) {}', timeoutMs: 100 })

    expect(value.success).toBe(false)
    expect(value.timedOut).toBe(true)
    expect(value.exitCode).toBeNull()
    expect(value.retained).toBe(true)
    expect(value.workdir).not.toBeNull()
  })

  it('keeps the scratch directory on request', async () => {
    harness = await createHarness()

    const value = await execute({
      code: 'System.out.println("ok");',
      keepWorkdir: true,
    })

    expect(value.success).toBe(true)
    expect(value.retained).toBe(true)
    expect(value.retainedReason).toBe('keepWorkdir was set')
    expect(value.scriptPath).not.toBeNull()
  })

  it('reports a missing jshell with actionable guidance', async () => {
    harness = await createHarness()
    const binary = join(
      harness.fake.home,
      'bin',
      process.platform === 'win32' ? 'jshell.exe' : 'jshell',
    )
    await rm(binary)

    const result = await harness.execute('java_eval', { code: '1 + 1' })

    expect(result.isError).toBe(true)
  })

  it('confines JShell under a workspace-write policy', async () => {
    harness = await createHarness({ mode: 'workspace-write' })

    const value = await execute({ code: 'System.out.println("ok");' })

    expect(value.success).toBe(true)
    expect(value.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'partial' })
    expect(harness.sandboxCalls).toHaveLength(1)
  })
})
