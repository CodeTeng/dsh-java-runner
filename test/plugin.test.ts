import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

const hasJdk = (() => {
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

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
  await ctx.plugin(plugin)

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
    for (const name of ['java_env', 'java_compile', 'java_run']) {
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
