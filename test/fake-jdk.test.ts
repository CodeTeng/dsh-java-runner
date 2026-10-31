import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import type { FakeJdk } from './helpers/fake-jdk.js'
import { createFakeJdk } from './helpers/fake-jdk.js'

interface FakeHarness {
  ctx: Context
  workspace: string
  fake: FakeJdk
  sandboxCalls: string[][]
  execute(name: string, args: unknown): Promise<Awaited<ReturnType<Context['tools']['execute']>>>
}

interface JdkValue {
  resolved: { home: string; version: string | null; vendor: string | null } | null
  guidance: string | null
}

interface DiagnosticValue {
  file: string | null
  line: number | null
  column: number | null
  severity: string
  code: string
  message: string
}

interface CompileValue {
  success: boolean
  diagnostics: DiagnosticValue[]
  unknownLines: string[]
  coverage: number
  workdir: string | null
  outDir: string | null
  retained: boolean
  retainedReason: string | null
}

interface RunValue {
  success: boolean
  timedOut: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  compile: { success: boolean } | null
  workdir: string | null
  retained: boolean
  sandbox: { mode: string; enforcement: string } | null
}

interface TestValue {
  success: boolean
  timedOut: boolean
  exitCode: number | null
  total: number
  passed: number
  failed: number
  skipped: number
  failures: { test: string; message: string; stackTrace: string }[]
  reportFiles: number
  compile: { success: boolean; diagnostics: DiagnosticValue[] } | null
  jar: { path: string; version: string | null; source: string }
  reportsDir: string | null
  workdir: string | null
  retained: boolean
  stdout: string
}

const FAILING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="FakeTest" tests="2" skipped="0" failures="1" errors="0" time="0.01">
  <testcase name="ok()" classname="FakeTest" time="0.001"/>
  <testcase name="bad()" classname="FakeTest" time="0.001">
    <failure message="boom" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: boom
	at FakeTest.bad(FakeTest.java:9)]]></failure>
  </testcase>
</testsuite>
`

const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="FakeTest" tests="1" skipped="0" failures="0" errors="0" time="0.01">
  <testcase name="ok()" classname="FakeTest" time="0.001"/>
</testsuite>
`

let harness: FakeHarness | undefined
const workspaces: string[] = []

async function createHarness(options: {
  mode?: 'workspace-write' | 'danger-full-access'
} = {}): Promise<FakeHarness> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-fake-jdk-workspace-'))
  workspaces.push(workspace)
  const fake = await createFakeJdk()
  const mode = options.mode ?? 'danger-full-access'
  const sandboxCalls: string[][] = []

  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  ctx.provide('subprocess', fake.service as never)
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode, workspaceRoot: workspace }),
  } as never)
  if (mode !== 'danger-full-access') {
    ctx.provide('sandbox', {
      confine: async (argv: readonly string[]) => {
        sandboxCalls.push([...argv])
        return {
          argv: [...argv],
          enforcement: 'partial',
          denialSignatures: [],
          runnerFailureRules: [],
        }
      },
    } as never)
  }
  await ctx.plugin(plugin, {
    javaHome: fake.home,
    timeoutMs: 5000,
    maxHeapMb: 64,
    junitJarPath: fake.jarPath,
  } as never)

  let counter = 0
  return {
    ctx,
    workspace,
    fake,
    sandboxCalls,
    execute(name, args) {
      counter += 1
      return ctx.tools.execute({
        callId: `fake:${counter}` as never,
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
    },
  }
}

async function execute<T>(name: string, args: unknown): Promise<T> {
  if (harness === undefined) throw new Error('fake harness is not initialized')
  const result = await harness.execute(name, args)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(`${name} returned a tool error`)
  return result.value as unknown as T
}

function reportsDirectory(argv: readonly string[]): string {
  const index = argv.indexOf('--reports-dir')
  const value = argv[index + 1]
  if (index < 0 || value === undefined) throw new Error('--reports-dir is missing from argv')
  return value
}

afterEach(async () => {
  if (harness) {
    harness.ctx.registry.delete(plugin)
    harness.ctx.registry.delete(ToolRuntime)
    await harness.fake.dispose()
    harness = undefined
  }
})

afterAll(async () => {
  await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })))
})

describe('fake JDK harness', () => {
  it('discovers a fake JDK through its canned probe output', async () => {
    harness = await createHarness()
    const value = await execute<JdkValue>('java_env', {})

    expect(value.resolved).not.toBeNull()
    expect(value.resolved?.home).toBe(harness.fake.home)
    expect(value.resolved?.version).toBe('17.0.9')
    expect(value.resolved?.vendor).toBe('FakeCorp')
  })

  it('reports discovery guidance when the probe fails', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) =>
      call.kind === 'javac' && call.probe
        ? { stderr: 'javac: exploded', exitCode: 1 }
        : undefined

    const value = await execute<JdkValue>('java_env', {})

    expect(value.resolved).toBeNull()
    expect(value.guidance).toContain('javac -version failed')
  })

  it('compiles with the UTF-8 diagnostic flags and a scrubbed environment', async () => {
    harness = await createHarness()
    const value = await execute<CompileValue>('java_compile', {
      files: [{ path: 'Fake.java', content: 'public class Fake {}' }],
    })

    expect(value.success).toBe(true)
    expect(value.diagnostics).toEqual([])
    expect(value.retained).toBe(false)
    expect(value.workdir).toBeNull()

    const call = harness.fake.callsOf('javac')[0]
    expect(call?.spec.argv).toContain('-XDrawDiagnostics')
    expect(call?.spec.argv).toContain('-encoding')
    expect(call?.spec.argv).toContain('UTF-8')
    expect(call?.spec.env?.['JAVA_HOME']).toBe(harness.fake.home)
    expect(call?.spec.env?.['JAVA_TOOL_OPTIONS']).toBeUndefined()
    expect(call?.spec.env?.['LANG']).toBe('en_US.UTF-8')
  })

  it('parses canned javac diagnostics and retains the scratch directory', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) =>
      call.kind === 'javac' && !call.probe
        ? { stderr: 'Fake.java:2:3: compiler.err.expected: token.identifier\n', exitCode: 1 }
        : undefined

    const value = await execute<CompileValue>('java_compile', {
      files: [{ path: 'Fake.java', content: 'public class Fake {}' }],
    })

    expect(value.success).toBe(false)
    expect(value.diagnostics).toHaveLength(1)
    expect(value.diagnostics[0]).toMatchObject({
      file: 'Fake.java',
      line: 2,
      column: 3,
      severity: 'error',
      code: 'compiler.err.expected',
    })
    expect(value.coverage).toBe(1)
    expect(value.retained).toBe(true)
    expect(value.retainedReason).toBe('the call did not succeed')
    expect(value.workdir).not.toBeNull()
    expect(value.outDir).toBe(join(value.workdir!, 'classes'))
  })

  it('runs a program with argv, stdin, and JVM options', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) => {
      if (call.probe) return undefined
      if (call.kind === 'javac') return { exitCode: 0 }
      return { stdout: 'fake-out\n', stderr: 'fake-err\n', exitCode: 0 }
    }

    const value = await execute<RunValue>('java_run', {
      main: 'Main',
      files: [{ path: 'Main.java', content: 'public class Main {}' }],
      args: ['alpha'],
      stdin: 'input\n',
    })

    expect(value.success).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.stdout).toBe('fake-out\n')
    expect(value.stderr).toBe('fake-err\n')
    expect(value.compile?.success).toBe(true)
    expect(value.retained).toBe(false)

    const call = harness.fake.callsOf('java')[0]
    expect(call?.spec.cwd).toBe(harness.workspace)
    expect(call?.spec.argv).toContain('Main')
    expect(call?.spec.argv).toContain('alpha')
    expect(call?.spec.argv).toContain('-Xmx64m')
    expect(call?.spec.argv).toContain('-Duser.language=en')
    expect(call?.spec.stdio.stdin).toEqual({ data: 'input\n' })
    expect(call?.spec.env?.['JAVA_HOME']).toBe(harness.fake.home)
  })

  it('reports a nonzero program exit as an unsuccessful run', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) => {
      if (call.probe) return undefined
      if (call.kind === 'javac') return { exitCode: 0 }
      return { stderr: 'boom\n', exitCode: 7 }
    }

    const value = await execute<RunValue>('java_run', {
      main: 'Main',
      files: [{ path: 'Main.java', content: 'public class Main {}' }],
    })

    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(7)
    expect(value.retained).toBe(true)
    expect(value.workdir).not.toBeNull()
  })

  it('terminates a hanging program on timeout', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) => {
      if (call.probe) return undefined
      if (call.kind === 'javac') return { exitCode: 0 }
      return { exitCode: 0, delayMs: 5000 }
    }

    const value = await execute<RunValue>('java_run', {
      main: 'Main',
      files: [{ path: 'Main.java', content: 'public class Main {}' }],
      timeoutMs: 100,
    })

    expect(value.success).toBe(false)
    expect(value.timedOut).toBe(true)
    expect(value.exitCode).toBeNull()
    expect(value.retained).toBe(true)
  })

  it('confines compile and run under a workspace-write policy', async () => {
    harness = await createHarness({ mode: 'workspace-write' })
    const value = await execute<RunValue>('java_run', {
      main: 'Main',
      files: [{ path: 'Main.java', content: 'public class Main {}' }],
    })

    expect(value.success).toBe(true)
    expect(value.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'partial' })
    expect(harness.sandboxCalls).toHaveLength(2)
  })

  it('parses fake JUnit reports into totals and failures', async () => {
    harness = await createHarness()
    harness.fake.handler = async (call) => {
      if (call.probe) return undefined
      if (call.kind === 'javac') return { exitCode: 0 }
      const directory = reportsDirectory(call.spec.argv)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'TEST-FakeTest.xml'), FAILING_XML)
      return { exitCode: 1 }
    }

    const value = await execute<TestValue>('java_test', {
      files: [{ path: 'FakeTest.java', content: 'public class FakeTest {}' }],
    })

    expect(value.compile?.success).toBe(true)
    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(1)
    expect(value.total).toBe(2)
    expect(value.passed).toBe(1)
    expect(value.failed).toBe(1)
    expect(value.skipped).toBe(0)
    expect(value.reportFiles).toBe(1)
    expect(value.failures[0]).toMatchObject({
      test: 'FakeTest#bad()',
      message: 'boom',
    })
    expect(value.failures[0]?.stackTrace).toContain('FakeTest.java:9')
    expect(value.jar.path).toBe(harness.fake.jarPath)
    expect(value.jar.source).toBe('config')
    expect(value.retained).toBe(true)
    expect(value.workdir).not.toBeNull()
    expect(value.reportsDir).toBe(join(value.workdir!, 'reports'))

    const call = harness.fake.callsOf('java')[0]
    expect(call?.spec.argv).toContain('execute')
    expect(call?.spec.argv).toContain('--reports-dir')
    expect(call?.spec.argv).toContain(harness.fake.jarPath)
  })

  it('cleans up when every fake JUnit test passes', async () => {
    harness = await createHarness()
    harness.fake.handler = async (call) => {
      if (call.probe) return undefined
      if (call.kind === 'javac') return { exitCode: 0 }
      const directory = reportsDirectory(call.spec.argv)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'TEST-FakeTest.xml'), PASSING_XML)
      return { exitCode: 0 }
    }

    const value = await execute<TestValue>('java_test', {
      files: [{ path: 'FakeTest.java', content: 'public class FakeTest {}' }],
    })

    expect(value.success).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.total).toBe(1)
    expect(value.passed).toBe(1)
    expect(value.failed).toBe(0)
    expect(value.retained).toBe(false)
    expect(value.workdir).toBeNull()
    expect(value.reportsDir).toBeNull()
  })

  it('fails when fake JUnit discovers no tests', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) => {
      if (call.probe) return undefined
      if (call.kind === 'javac') return { exitCode: 0 }
      return { exitCode: 2 }
    }

    const value = await execute<TestValue>('java_test', {
      files: [{ path: 'Plain.java', content: 'public class Plain {}' }],
    })

    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(2)
    expect(value.total).toBe(0)
    expect(value.retained).toBe(true)
  })

  it('does not start the test runner when compilation fails', async () => {
    harness = await createHarness()
    harness.fake.handler = (call) =>
      call.kind === 'javac' && !call.probe
        ? { stderr: 'BrokenTest.java:1:1: compiler.err.expected: token.identifier\n', exitCode: 1 }
        : undefined

    const value = await execute<TestValue>('java_test', {
      files: [{ path: 'BrokenTest.java', content: 'public class BrokenTest {}' }],
    })

    expect(value.success).toBe(false)
    expect(value.compile?.success).toBe(false)
    expect(value.compile?.diagnostics).toHaveLength(1)
    expect(value.total).toBe(0)
    expect(value.reportsDir).toBeNull()
    expect(value.stdout).toBe('')
    expect(value.retained).toBe(true)
    expect(harness.fake.callsOf('java')).toHaveLength(0)
  })
})
