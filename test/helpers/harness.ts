import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../../src/index.js'
import type { FakeJdk } from './fake-jdk.js'
import { createFakeJdk } from './fake-jdk.js'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface HarnessOptions {
  mode?: SandboxMode
  config?: Record<string, unknown>
  workspacePrefix?: string
}

export interface Harness {
  ctx: Context
  workspace: string
  fake: FakeJdk
  sandboxCalls: string[][]
  execute(name: string, args: unknown): Promise<Awaited<ReturnType<Context['tools']['execute']>>>
  dispose(): Promise<void>
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), options.workspacePrefix ?? 'dsh-java-test-'))
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
    buildTimeoutMs: 5000,
    junitJarPath: fake.jarPath,
    ...options.config,
  } as never)

  let counter = 0
  let disposed = false
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
    async dispose() {
      if (disposed) return
      disposed = true
      ctx.registry.delete(plugin)
      ctx.registry.delete(ToolRuntime)
      await fake.dispose()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}
