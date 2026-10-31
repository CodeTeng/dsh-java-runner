import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JdkCandidate } from './jdk.js'
import { parseJunitReports } from './parsers/junit.js'
import type { JunitFailure } from './parsers/junit.js'
import { environmentFor, runProcess } from './proc.js'
import type { ProcessSandboxFacts } from './proc.js'
import { jvmRuntimeOptions } from './run.js'

export interface JunitRunOptions {
  ctx: Context
  policy: SandboxExecutionPolicy
  exec: ToolRunContext
  jdk: JdkCandidate
  workspaceRoot: string
  workdir: string
  outDir: string
  jarPath: string
  classpath: readonly string[]
  tests: readonly string[]
  timeoutMs: number
  maxHeapMb: number
}

export interface JunitRunResult {
  reportsDir: string
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
  total: number
  passed: number
  failed: number
  skipped: number
  failures: JunitFailure[]
  reportFiles: number
  sandbox: ProcessSandboxFacts | null
  sandboxDenied: boolean
  runnerFailure: string | null
}

export function junitArgv(
  jdk: JdkCandidate,
  options: {
    jarPath: string
    classpath: readonly string[]
    reportsDir: string
    tests: readonly string[]
    maxHeapMb: number
  },
): string[] {
  const argv = [
    jdk.javaPath ?? 'java',
    ...jvmRuntimeOptions(options.maxHeapMb),
    '-jar',
    options.jarPath,
    'execute',
    '--class-path',
    options.classpath.join(delimiter),
    '--reports-dir',
    options.reportsDir,
    '--details=none',
    '--disable-banner',
    '--disable-ansi-colors',
    '--fail-if-no-tests',
  ]
  if (options.tests.length === 0) {
    argv.push('--scan-class-path')
  } else {
    for (const test of options.tests) {
      argv.push(test.includes('#') ? `--select-method=${test}` : `--select-class=${test}`)
    }
  }
  return argv
}

export async function runJunit(options: JunitRunOptions): Promise<JunitRunResult> {
  const reportsDir = join(options.workdir, 'reports')
  const argv = junitArgv(options.jdk, {
    jarPath: options.jarPath,
    classpath: [options.outDir, ...options.classpath],
    reportsDir,
    tests: options.tests,
    maxHeapMb: options.maxHeapMb,
  })

  const result = await runProcess(options.ctx, {
    argv,
    cwd: options.workspaceRoot,
    env: environmentFor(options.jdk.home),
    timeoutMs: options.timeoutMs,
    signal: options.exec.signal,
    spillDir: options.workdir,
    policy: options.policy,
    stdoutMaxBytes: 256 * 1024,
    stderrMaxBytes: 256 * 1024,
  })
  options.exec.signal.throwIfAborted()

  const reports = await parseJunitReports(reportsDir)

  return {
    reportsDir,
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
    total: reports.total,
    passed: reports.passed,
    failed: reports.failed,
    skipped: reports.skipped,
    failures: reports.failures,
    reportFiles: reports.reportFiles,
    sandbox: result.sandbox,
    sandboxDenied: result.sandboxDenied,
    runnerFailure: result.runnerFailure,
  }
}
