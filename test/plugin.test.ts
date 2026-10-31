import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

const JUNIT_FILENAME = 'junit-platform-console-standalone-1.13.4.jar'

const jdkMajor = (() => {
  try {
    const output = execFileSync('javac', ['-version'], { encoding: 'utf8' })
    const version = /javac (\d+)/.exec(output)?.[1]
    return version === undefined ? 0 : Number(version)
  } catch {
    return 0
  }
})()

const hasJdk = jdkMajor > 0

const junitJar = (() => {
  const candidates: (string | undefined)[] = [
    process.env['JUNIT_JAR'],
    join(
      homedir(),
      '.m2',
      'repository',
      'org',
      'junit',
      'platform',
      'junit-platform-console-standalone',
      '1.13.4',
      JUNIT_FILENAME,
    ),
    join(homedir(), '.dsh-java-runner', 'junit', JUNIT_FILENAME),
  ]
  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate)) ?? null
})()

const canRunJunit = jdkMajor >= 17 && junitJar !== null

interface Harness {
  ctx: Context
  workspace: string
  sandboxCalls: string[][]
  execute(name: string, args: unknown): Promise<Awaited<ReturnType<Context['tools']['execute']>>>
}

let harness: Harness | undefined
const workspaces: string[] = []

async function createHarness(options?: {
  mode?: 'workspace-write' | 'danger-full-access'
  config?: { junitJarPath?: string }
}): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-java-runner-test-'))
  workspaces.push(workspace)
  const mode = options?.mode ?? 'danger-full-access'
  const sandboxCalls: string[][] = []

  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
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
          denialSignatures: ['Operation not permitted'],
          runnerFailureRules: [],
        }
      },
    } as never)
  }
  await ctx.plugin(plugin, options?.config as never)

  let counter = 0
  return {
    ctx,
    workspace,
    sandboxCalls,
    execute(name, args) {
      counter += 1
      return ctx.tools.execute({
        callId: `test:${counter}` as never,
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
    },
  }
}

afterEach(async () => {
  if (harness) {
    harness.ctx.registry.delete(plugin)
    harness.ctx.registry.delete(LocalSubprocessRuntime)
    harness.ctx.registry.delete(ToolRuntime)
    harness = undefined
  }
})

afterAll(async () => {
  await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })))
})

describe('plugin loading', () => {
  it('registers the Java tools in a real tool runtime', async () => {
    harness = await createHarness()
    for (const name of ['java_env', 'java_compile', 'java_run', 'java_test']) {
      expect(harness.ctx.tools.get(name)?.name).toBe(name)
    }
  })
})

describe.skipIf(!hasJdk)('java tools with a real JDK', () => {
  it('discovers a JDK', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_env', {})
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as {
      resolved: { version: string | null; javacPath: string | null } | null
    }
    expect(value.resolved).not.toBeNull()
    expect(value.resolved?.version).toMatch(/^\d+/)
    expect(value.resolved?.javacPath).toMatch(/javac/)
  })

  it('compiles a multi-file program and cleans up on success', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_compile', {
      files: [
        {
          path: 'src/Greeter.java',
          content: 'public class Greeter { public static String greet() { return "hi"; } }',
        },
        {
          path: 'src/Main.java',
          content:
            'public class Main { public static void main(String[] args) { System.out.println(Greeter.greet()); } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as {
      success: boolean
      diagnostics: unknown[]
      workdir: string | null
      retained: boolean
    }
    expect(value.success).toBe(true)
    expect(value.diagnostics).toEqual([])
    expect(value.retained).toBe(false)
    expect(value.workdir).toBeNull()
  })

  it('returns structured diagnostics for broken source', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_compile', {
      files: [
        {
          path: 'Main.java',
          content: 'public class Main { void f() { int x = ; } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as {
      success: boolean
      diagnostics: {
        file: string | null
        line: number | null
        column: number | null
        severity: string
        code: string
        message: string
      }[]
      coverage: number
      workdir: string | null
    }
    expect(value.success).toBe(false)
    expect(value.diagnostics.length).toBeGreaterThan(0)
    const first = value.diagnostics[0]
    expect(first?.file).toBe('Main.java')
    expect(first?.line).toBe(1)
    expect(first?.column).toBeGreaterThan(0)
    expect(first?.severity).toBe('error')
    expect(first?.code).toMatch(/^compiler\.err\./)
    expect(value.coverage).toBe(1)
    expect(value.workdir).not.toBeNull()
  })

  it('keeps non-ASCII identifiers readable in diagnostics', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_compile', {
      files: [
        {
          path: 'Main.java',
          content: 'public class Main { void f() { System.out.println(未定义); } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as {
      diagnostics: { message: string }[]
    }
    expect(value.diagnostics.length).toBeGreaterThan(0)
    expect(value.diagnostics[0]?.message).toContain('未定义')
  })

  it('round-trips non-ASCII program output', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_run', {
      main: 'Main',
      files: [
        {
          path: 'Main.java',
          content:
            'public class Main { public static void main(String[] a) { System.out.println("你好，世界"); } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as { success: boolean; stdout: string }
    expect(value.success).toBe(true)
    expect(value.stdout.trim()).toBe('你好，世界')
  })

  it('runs a main class with a Unicode name', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_run', {
      main: '你好',
      files: [
        {
          path: '你好.java',
          content:
            'public class 你好 { public static void main(String[] a) { System.out.println("你好，世界"); } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as { success: boolean; stdout: string }
    expect(value.success).toBe(true)
    expect(value.stdout.trim()).toBe('你好，世界')
  })

  it('rejects malformed main class names', async () => {
    harness = await createHarness()
    for (const main of ['Main; calc', '1Main', 'a..b', 'com.example.']) {
      const result = await harness.execute('java_run', { main })
      expect(result.isError).toBe(true)
    }
  })

  it('reports the class files directory for a kept compile', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_compile', {
      files: [
        {
          path: 'Main.java',
          content: 'public class Main { public static void main(String[] a) {} }',
        },
      ],
      keepWorkdir: true,
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as {
      success: boolean
      retained: boolean
      workdir: string | null
      outDir: string | null
    }
    expect(value.success).toBe(true)
    expect(value.retained).toBe(true)
    expect(value.workdir).not.toBeNull()
    expect(value.outDir).toBe(join(value.workdir!, 'classes'))
  })

  it('enforces the heap cap', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_run', {
      main: 'Main',
      maxHeapMb: 16,
      files: [
        {
          path: 'Main.java',
          content:
            'public class Main { public static void main(String[] a) { int[] big = new int[100_000_000]; System.out.println(big.length); } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as { success: boolean; exitCode: number | null; stderr: string }
    expect(value.success).toBe(false)
    expect(value.exitCode).not.toBe(0)
    expect(value.stderr).toContain('OutOfMemoryError')
  })

  it('runs a program with stdin and arguments', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_run', {
      main: 'Main',
      files: [
        {
          path: 'Main.java',
          content: `import java.io.*;
public class Main {
  public static void main(String[] args) throws Exception {
    BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
    System.out.println("args=" + String.join(",", args) + " stdin=" + reader.readLine());
  }
}`,
        },
      ],
      args: ['a', 'b'],
      stdin: 'hello\n',
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as {
      success: boolean
      exitCode: number | null
      stdout: string
      compile: { success: boolean } | null
      retained: boolean
    }
    expect(value.success).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.stdout.trim()).toBe('args=a,b stdin=hello')
    expect(value.compile?.success).toBe(true)
    expect(value.retained).toBe(false)
  })

  it('returns a nonzero exit code without failing the tool call', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_run', {
      main: 'Main',
      files: [
        {
          path: 'Main.java',
          content: 'public class Main { public static void main(String[] a) { System.exit(3); } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as { success: boolean; exitCode: number | null; retained: boolean }
    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(3)
    expect(value.retained).toBe(true)
  })

  it('terminates a program on timeout', async () => {
    harness = await createHarness()
    const result = await harness.execute('java_run', {
      main: 'Main',
      files: [
        {
          path: 'Main.java',
          content:
            'public class Main { public static void main(String[] a) throws Exception { Thread.sleep(30000); } }',
        },
      ],
      timeoutMs: 800,
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as { success: boolean; timedOut: boolean; retained: boolean }
    expect(value.success).toBe(false)
    expect(value.timedOut).toBe(true)
    expect(value.retained).toBe(true)
  }, 20_000)

  it('rejects paths outside the workspace', async () => {
    harness = await createHarness()
    const absolute = await harness.execute('java_compile', {
      files: [{ path: join(harness.workspace, 'Main.java') }],
    })
    expect(absolute.isError).toBe(true)

    const traversal = await harness.execute('java_compile', {
      files: [{ path: '../Main.java' }],
    })
    expect(traversal.isError).toBe(true)
  })

  it('confines javac and java under a workspace-write policy', async () => {
    harness = await createHarness({ mode: 'workspace-write' })
    const result = await harness.execute('java_run', {
      main: 'Main',
      files: [
        {
          path: 'Main.java',
          content: 'public class Main { public static void main(String[] a) { System.out.println("ok"); } }',
        },
      ],
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as {
      success: boolean
      sandbox: { mode: string; enforcement: string } | null
      stdout: string
    }
    expect(value.success).toBe(true)
    expect(value.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'partial' })
    expect(harness.sandboxCalls).toHaveLength(2)
    expect(value.stdout.trim()).toBe('ok')
  })
})

interface JunitResult {
  success: boolean
  timedOut: boolean
  exitCode: number | null
  total: number
  passed: number
  failed: number
  skipped: number
  failures: { test: string; message: string; stackTrace: string }[]
  reportFiles: number
  compile: { success: boolean; diagnostics: unknown[] } | null
  jar: { path: string; version: string | null; source: string }
  reportsDir: string | null
  workdir: string | null
  outDir: string | null
  retained: boolean
  stdout: string
  stderr: string
}

describe.skipIf(!canRunJunit)('java_test with a real JDK and JUnit', () => {
  async function execute(args: unknown): Promise<JunitResult> {
    harness = await createHarness({ config: { junitJarPath: junitJar ?? undefined } })
    const result = await harness.execute('java_test', args)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('java_test returned a tool error')
    return result.value as unknown as JunitResult
  }

  const calculator = `import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

public class CalcTest {
  @Test
  void adds() { assertEquals(2, 1 + 1); }
  @Test
  void subtracts() { assertEquals(2, 3 - 2); }
  @Disabled("not yet")
  @Test
  void todo() { }
}`

  it('reports passing, failing, and skipped tests with stack traces', async () => {
    const value = await execute({
      files: [{ path: 'test/CalcTest.java', content: calculator }],
    })

    expect(value.compile?.success).toBe(true)
    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(1)
    expect(value.total).toBe(3)
    expect(value.passed).toBe(1)
    expect(value.failed).toBe(1)
    expect(value.skipped).toBe(1)
    expect(value.reportFiles).toBeGreaterThan(0)
    expect(value.failures).toHaveLength(1)
    expect(value.failures[0]?.test).toContain('CalcTest#subtracts')
    expect(value.failures[0]?.message).toContain('expected: <2>')
    expect(value.failures[0]?.stackTrace).toContain('AssertionFailedError')
    expect(value.retained).toBe(true)
    expect(value.workdir).not.toBeNull()
    expect(value.reportsDir).toBe(join(value.workdir!, 'reports'))
  })

  it('cleans up the scratch directory when every test passes', async () => {
    const value = await execute({
      files: [
        {
          path: 'CalcTest.java',
          content: `import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

public class CalcTest {
  @Test
  void adds() { assertEquals(2, 1 + 1); }
}`,
        },
      ],
    })

    expect(value.success).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.total).toBe(1)
    expect(value.passed).toBe(1)
    expect(value.failed).toBe(0)
    expect(value.failures).toEqual([])
    expect(value.retained).toBe(false)
    expect(value.workdir).toBeNull()
    expect(value.reportsDir).toBeNull()
    expect(value.jar.path).toBe(junitJar)
  })

  it('selects a single test method by name', async () => {
    const value = await execute({
      files: [
        {
          path: 'SelectorTest.java',
          content: `import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertTrue;

public class SelectorTest {
  @Test
  void adds() { assertTrue(true); }
  @Test
  void other() { assertTrue(true); }
}`,
        },
      ],
      tests: ['SelectorTest#adds'],
    })

    expect(value.success).toBe(true)
    expect(value.total).toBe(1)
    expect(value.passed).toBe(1)
  })

  it('fails when no tests are discovered', async () => {
    const value = await execute({
      files: [
        {
          path: 'Plain.java',
          content: 'public class Plain { static int add(int a, int b) { return a + b; } }',
        },
      ],
    })

    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(2)
    expect(value.total).toBe(0)
    expect(value.retained).toBe(true)
  })

  it('returns compile diagnostics without starting the JUnit run', async () => {
    const value = await execute({
      files: [
        {
          path: 'BrokenTest.java',
          content: 'public class BrokenTest { void f() { int x = ; } }',
        },
      ],
    })

    expect(value.success).toBe(false)
    expect(value.timedOut).toBe(false)
    expect(value.compile?.success).toBe(false)
    expect(value.compile?.diagnostics.length).toBeGreaterThan(0)
    expect(value.total).toBe(0)
    expect(value.reportsDir).toBeNull()
    expect(value.stdout).toBe('')
    expect(value.retained).toBe(true)
  })

  it('terminates the test run on timeout', async () => {
    const value = await execute({
      files: [
        {
          path: 'SlowTest.java',
          content: `import org.junit.jupiter.api.Test;

public class SlowTest {
  @Test
  void slow() throws Exception { Thread.sleep(30000); }
}`,
        },
      ],
      timeoutMs: 800,
    })

    expect(value.success).toBe(false)
    expect(value.timedOut).toBe(true)
    expect(value.total).toBe(0)
    expect(value.retained).toBe(true)
  }, 20_000)
})
