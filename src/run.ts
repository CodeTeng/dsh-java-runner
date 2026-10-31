import { delimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JdkCandidate } from './jdk.js'
import { environmentFor, runProcess } from './proc.js'
import type { ProcessSandboxFacts } from './proc.js'

export interface RunOptions {
  ctx: Context
  policy: SandboxExecutionPolicy
  exec: ToolRunContext
  jdk: JdkCandidate
  workspaceRoot: string
  workdir: string
  outDir: string | null
  main: string
  args: readonly string[]
  stdin?: string
  timeoutMs: number
  maxHeapMb: number
  classpath: readonly string[]
}

export interface RunCoreResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutSpillPath: string | null
  stderrSpillPath: string | null
  durationMs: number
  timedOut: boolean
  sandbox: ProcessSandboxFacts | null
  sandboxDenied: boolean
  runnerFailure: string | null
}

export function jvmRuntimeOptions(maxHeapMb: number): string[] {
  return [
    '-Duser.language=en',
    '-Duser.country=US',
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    `-Xmx${maxHeapMb}m`,
  ]
}

export function javaArgv(
  jdk: JdkCandidate,
  options: {
    main: string
    args: readonly string[]
    classpath: readonly string[]
    maxHeapMb: number
  },
): string[] {
  const argv = [
    jdk.javaPath ?? 'java',
    ...jvmRuntimeOptions(options.maxHeapMb),
  ]
  if (options.classpath.length > 0) {
    argv.push('-cp', options.classpath.join(delimiter))
  }
  argv.push(options.main, ...options.args)
  return argv
}

export async function runJava(options: RunOptions): Promise<RunCoreResult> {
  const classpath = options.outDir === null ? options.classpath : [options.outDir, ...options.classpath]
  const argv = javaArgv(options.jdk, {
    main: options.main,
    args: options.args,
    classpath,
    maxHeapMb: options.maxHeapMb,
  })

  const result = await runProcess(options.ctx, {
    argv,
    cwd: options.workspaceRoot,
    env: environmentFor(options.jdk.home),
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
    signal: options.exec.signal,
    spillDir: options.workdir,
    policy: options.policy,
    stdoutMaxBytes: 256 * 1024,
    stderrMaxBytes: 256 * 1024,
  })
  options.exec.signal.throwIfAborted()

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutSpillPath: result.stdoutSpillPath,
    stderrSpillPath: result.stderrSpillPath,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    sandbox: result.sandbox,
    sandboxDenied: result.sandboxDenied,
    runnerFailure: result.runnerFailure,
  }
}
