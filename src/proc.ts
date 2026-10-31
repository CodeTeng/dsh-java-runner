import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import {
  classifyRunnerFailure,
  matchesSignature,
} from '@deepseek-ai/dsh-sandbox'
import type {
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'

export interface ProcessSandboxFacts {
  mode: SandboxPolicy['mode']
  enforcement: SandboxEnforcement
}

export interface ProcessResult {
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
  aborted: boolean
  sandbox: ProcessSandboxFacts | null
  sandboxDenied: boolean
  runnerFailure: string | null
}

export interface RunProcessOptions {
  argv: readonly string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs: number
  signal: AbortSignal
  spillDir?: string
  policy?: SandboxExecutionPolicy
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  graceMs?: number
}

const DEFAULT_OUTPUT_BYTES = 256 * 1024
const SPILL_BYTES = 8 * 1024 * 1024
const DEFAULT_GRACE_MS = 2000

export async function runProcess(
  ctx: Context,
  options: RunProcessOptions,
): Promise<ProcessResult> {
  options.signal.throwIfAborted()

  const subprocess = ctx.get('subprocess')
  if (!subprocess) {
    throw new Error('dsh-java-runner requires the subprocess service (ctx.subprocess)')
  }

  let argv = [...options.argv]
  let sandbox: ProcessSandboxFacts | null = null
  let denialSignatures: readonly string[] = []
  let runnerFailureRules: readonly RunnerFailureRule[] = []

  const policy = options.policy
  if (policy && policy.mode !== 'danger-full-access') {
    const mode = policy.mode
    const provider = ctx.get('sandbox')
    if (!provider) {
      throw new Error(
        `The session sandbox mode is "${mode}", but no sandbox provider is loaded (ctx.sandbox). Refusing to run unconfined.`,
      )
    }
    const confined = await provider.confine(
      argv,
      { mode, workspaceRoot: policy.workspaceRoot, sessionId: policy.sessionId },
      options.signal,
    )
    argv = [...confined.argv]
    sandbox = { mode, enforcement: confined.enforcement }
    denialSignatures = confined.denialSignatures
    runnerFailureRules = confined.runnerFailureRules
  }

  const timeout = new AbortController()
  let timedOut = false
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          timeout.abort()
        }, options.timeoutMs)
      : undefined
  timer?.unref?.()

  const signal =
    timer === undefined ? options.signal : AbortSignal.any([options.signal, timeout.signal])

  const maxStdout = options.stdoutMaxBytes ?? DEFAULT_OUTPUT_BYTES
  const maxStderr = options.stderrMaxBytes ?? DEFAULT_OUTPUT_BYTES

  const startedAt = Date.now()
  try {
    const handle = subprocess.spawn({
      argv,
      cwd: options.cwd,
      env: options.env,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: collectSpec(maxStdout, options.spillDir),
        stderr: collectSpec(maxStderr, options.spillDir),
      },
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      signal,
    })

    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error(
        `Failed to run ${options.argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const durationMs = Date.now() - startedAt
    const stdout = readCollected(handle.collected.stdout)
    const stderr = readCollected(handle.collected.stderr)

    const aborted = options.signal.aborted
    const runnerFailure = classifyRunnerFailure(
      outcome.exitCode,
      stderr.text,
      runnerFailureRules,
    )
    const sandboxDenied =
      sandbox !== null &&
      runnerFailure === undefined &&
      matchesSignature(outcome.exitCode, stderr.text, denialSignatures)

    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutSpillPath: stdout.spillPath ?? null,
      stderrSpillPath: stderr.spillPath ?? null,
      durationMs,
      timedOut: timedOut && !aborted,
      aborted,
      sandbox,
      sandboxDenied,
      runnerFailure: runnerFailure?.detail ?? null,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function collectSpec(maxBytes: number, spillDir: string | undefined) {
  return spillDir === undefined ? { maxBytes } : { maxBytes, spill: { maxBytes: SPILL_BYTES } }
}

function readCollected(reader: SubprocessOutputReader | undefined): {
  text: string
  truncated: boolean
  spillPath?: string
} {
  if (!reader) return { text: '', truncated: false }
  const read = reader.readFrom(0)
  return { text: read.text, truncated: read.lossy, spillPath: read.spillPath }
}

export function environmentFor(javaHome: string): NodeJS.ProcessEnv {
  return {
    JAVA_HOME: javaHome,
    JAVA_TOOL_OPTIONS: undefined,
    JDK_JAVA_OPTIONS: undefined,
    _JAVA_OPTIONS: undefined,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  }
}
