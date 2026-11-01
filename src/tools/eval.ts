import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { resolveClasspath } from '../compile.js'
import { dockerConfiguration } from '../docker.js'
import { runJshell } from '../eval.js'
import { createWorkdir, removeScratch } from '../inputs.js'
import type { JdkResolver } from '../jdk.js'
import {
  decideRetention,
  dockerFactsSchema,
  nullableNumber,
  nullableString,
  resolvePolicy,
  sandboxFactsSchema,
  truncationNote,
} from './shared.js'

interface EvalMeta {
  success: boolean
  errorCount: number
  timedOut: boolean
  output: string
  exitCode: number | null
}

const MODEL_OUTPUT_LIMIT = 8_000

export function registerEvalTool(
  ctx: Context,
  config: Config,
  resolver: JdkResolver,
): void {
  ctx.tools.register(
    defineTool({
      name: 'java_eval',
      description:
        'Evaluate Java snippets in one JShell session without creating a main class. Use this for quick experiments and interactive exploration; use java_run when you need a real program entry point, and java_test for assertions. Bare expression values are not printed in script mode, so wrap visible output in System.out.println(...). JShell keeps exit code 0 even when snippets fail, so errors and exceptions are detected from its output. Requires a full JDK that includes jshell.',
      parameters: {
        code: {
          type: 'string',
          required: true,
          description:
            'JShell script: Java declarations, expressions, and statements separated by newlines or semicolons',
        },
        classpath: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional classpath entries; relative entries resolve against the workspace root',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Evaluation timeout in milliseconds (defaults to the plugin config)',
        },
        maxHeapMb: {
          type: 'integer',
          description: 'Heap cap for the JShell execution engine in MiB (defaults to the plugin config)',
        },
        keepWorkdir: {
          type: 'boolean',
          description: 'Keep the scratch directory and script even when evaluation succeeds',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            timedOut: { type: 'boolean', required: true },
            exitCode: nullableNumber,
            durationMs: { type: 'number', required: true },
            jshell: { type: 'string', required: true },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            errors: { type: 'array', items: { type: 'string' }, required: true },
            classpath: { type: 'array', items: { type: 'string' }, required: true },
            workdir: nullableString,
            scriptPath: nullableString,
            retained: { type: 'boolean', required: true },
            retainedReason: nullableString,
            stdoutTruncated: { type: 'boolean', required: true },
            stderrTruncated: { type: 'boolean', required: true },
            stdoutSpillPath: nullableString,
            stderrSpillPath: nullableString,
            sandbox: sandboxFactsSchema,
            sandboxDenied: { type: 'boolean', required: true },
            runnerFailure: nullableString,
            docker: dockerFactsSchema,
          },
        },
        presentationMeta: (_args, value) => ({
          success: value.success,
          errorCount: value.errors.length,
          timedOut: value.timedOut,
          output: preview(value),
          exitCode: value.exitCode,
        }) satisfies EvalMeta,
        render: (_args, value) => {
          const lines: string[] = []
          if (value.timedOut) {
            lines.push(`JShell timed out after ${value.durationMs} ms`)
          } else if (value.runnerFailure !== null) {
            lines.push(`JShell failed after ${value.durationMs} ms: ${value.runnerFailure}`)
          } else {
            lines.push(
              `JShell finished with exit code ${value.exitCode ?? 'unknown'} in ${value.durationMs} ms`,
            )
          }

          if (value.errors.length > 0) {
            lines.push('', 'Errors and exceptions:')
            for (const error of value.errors.slice(0, 10)) lines.push(`- ${error}`)
            if (value.errors.length > 10) {
              lines.push(`... ${value.errors.length - 10} more in the structured result`)
            }
          }
          if (value.stdout !== '') {
            lines.push('', 'stdout:', clip(value.stdout, MODEL_OUTPUT_LIMIT))
          }
          if (value.stderr !== '') {
            lines.push('', 'stderr:', clip(value.stderr, MODEL_OUTPUT_LIMIT))
          }
          if (value.stdout === '' && value.errors.length === 0 && !value.timedOut) {
            lines.push(
              '',
              'The snippet produced no output. JShell does not print bare expression values in script mode; use System.out.println(...) for visible output.',
            )
          }
          const notes = truncationNote(
            value.stdoutTruncated,
            value.stderrTruncated,
            value.stdoutSpillPath,
            value.stderrSpillPath,
          )
          if (notes !== '') lines.push('', notes)
          if (value.sandboxDenied) {
            lines.push('', 'The sandbox denied a file effect; the output above may reflect that.')
          }
          if (value.docker !== null) {
            lines.push(
              '',
              `Docker: ${value.docker.image} (network ${value.docker.network}, container ${value.docker.container})`,
            )
          }
          lines.push('', `JShell: ${value.jshell}`)
          if (value.retained && value.workdir !== null) {
            lines.push(`Scratch directory kept at ${value.workdir}`)
            if (value.scriptPath !== null) lines.push(`Script: ${value.scriptPath}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall: () => ({
        card: 'terminal',
        title: 'jshell',
        description: 'Evaluate Java snippets in JShell',
      }),
      presentResult: (_args, result) => {
        const meta = result.meta as unknown as EvalMeta | undefined
        if (meta === undefined) return undefined
        return {
          card: 'terminal',
          title: meta.timedOut
            ? 'jshell: timed out'
            : meta.errorCount > 0
              ? `jshell: ${meta.errorCount} error(s)`
              : meta.success
                ? 'jshell: ok'
                : 'jshell: failed',
          output: meta.output,
          ...(meta.exitCode === null ? {} : { exitCode: meta.exitCode }),
        }
      },
      async execute(args, exec) {
        const code = args.code
        if (code.trim() === '') throw new Error('java_eval requires non-empty code')
        if (code.includes('\0')) throw new Error('code must not contain NUL bytes')

        const timeoutMs = args.timeoutMs ?? config.timeoutMs
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
          throw new Error('timeoutMs must be a positive number no greater than 600000')
        }
        const maxHeapMb = args.maxHeapMb ?? config.maxHeapMb
        if (!Number.isInteger(maxHeapMb) || maxHeapMb < 8 || maxHeapMb > 32_768) {
          throw new Error('maxHeapMb must be an integer between 8 and 32768')
        }

        const policy = resolvePolicy(ctx, exec)
        const workspaceRoot = policy.workspaceRoot
        const docker = dockerConfiguration(config)
        const classpath = resolveClasspath(args.classpath, workspaceRoot)
        const jdk =
          docker === null
            ? await resolver.require({
                workspaceRoot,
                signal: exec.signal,
              })
            : null
        const workdir = await createWorkdir(
          workspaceRoot,
          config.scratchRoot,
          String(exec.callId),
        )
        const scriptPath = join(workdir, 'snippet.jsh')
        const keepWorkdir = args.keepWorkdir ?? false

        try {
          const run = await runJshell({
            ctx,
            policy,
            exec,
            jdk,
            workspaceRoot,
            workdir,
            scriptPath,
            code,
            classpath,
            timeoutMs,
            maxHeapMb,
            docker,
          })
          const truncated = run.stdoutTruncated || run.stderrTruncated
          const success =
            run.exitCode === 0 &&
            !run.timedOut &&
            !run.sandboxDenied &&
            run.runnerFailure === null &&
            run.errors.length === 0
          const retention = decideRetention({
            keepWorkdir,
            success,
            truncated,
            timedOut: run.timedOut,
          })
          if (!retention.retained) await removeScratch(workdir)

          return {
            success,
            timedOut: run.timedOut,
            exitCode: run.exitCode,
            durationMs: run.durationMs,
            jshell: run.jshell,
            stdout: run.stdout,
            stderr: run.stderr,
            errors: run.errors,
            classpath,
            workdir: retention.retained ? workdir : null,
            scriptPath: retention.retained ? scriptPath : null,
            retained: retention.retained,
            retainedReason: retention.reason,
            stdoutTruncated: run.stdoutTruncated,
            stderrTruncated: run.stderrTruncated,
            stdoutSpillPath: run.stdoutSpillPath,
            stderrSpillPath: run.stderrSpillPath,
            sandbox: run.sandbox,
            sandboxDenied: run.sandboxDenied,
            runnerFailure: run.runnerFailure,
            docker: run.docker,
          }
        } catch (error) {
          if (!keepWorkdir) await removeScratch(workdir).catch(() => {})
          throw error
        }
      },
    }),
  )
}

function preview(value: {
  stdout: string
  stderr: string
  errors: readonly string[]
  timedOut: boolean
}): string {
  if (value.timedOut) return 'timed out'
  if (value.errors.length > 0) return value.errors.slice(0, 2).join('\n')
  const text = value.stdout.trim() || value.stderr.trim()
  return clip(text, 500)
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n... (${text.length - limit} more characters)`
}
