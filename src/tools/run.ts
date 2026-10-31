import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { compileJava, resolveClasspath } from '../compile.js'
import type { Diagnostic } from '../parsers/javac.js'
import type { SourceFileRequest } from '../inputs.js'
import { createScratch, removeScratch } from '../inputs.js'
import type { JdkResolver } from '../jdk.js'
import { runJava } from '../run.js'
import {
  compileResultProperties,
  countSeverities,
  decideRetention,
  nullableNumber,
  nullableString,
  renderDiagnostics,
  resolvePolicy,
  sandboxFactsSchema,
  truncationNote,
} from './shared.js'

const MAIN_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/

const compileSummarySchema = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        success: compileResultProperties.success,
        diagnostics: compileResultProperties.diagnostics,
        unknownLines: compileResultProperties.unknownLines,
        coverage: compileResultProperties.coverage,
        durationMs: compileResultProperties.durationMs,
        sandboxDenied: compileResultProperties.sandboxDenied,
        runnerFailure: compileResultProperties.runnerFailure,
        outputTruncated: compileResultProperties.outputTruncated,
      },
    },
  ],
  required: true,
} as const

const filesSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', required: true },
      content: { type: 'string' },
    },
  },
  description:
    'Java sources to compile before running; omit to run an already-compiled main class from the classpath',
} as const

interface RunMeta {
  main: string
  output: string
  exitCode: number | null
  signal: string | null
  compileFailed: boolean
}

const MODEL_STDOUT_LIMIT = 16_000
const MODEL_STDERR_LIMIT = 8_000

export function registerRunTool(
  ctx: Context,
  config: Config,
  resolver: JdkResolver,
): void {
  ctx.tools.register(
    defineTool({
      name: 'java_run',
      description:
        'Compile (when sources are given) and run a Java main class with the resolved JDK. Returns exit code, stdout, stderr, timeout state, and structured compile diagnostics. The process runs in the session workspace with a heap cap and a timeout; its process tree is terminated on expiry. Prefer this over "java" or "javac && java" in a shell: output is UTF-8 decoded, diagnostics are parsed, and the sandbox policy is honored.',
      parameters: {
        main: {
          type: 'string',
          required: true,
          description: 'Fully qualified main class, for example "com.example.Main"',
        },
        files: filesSchema,
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Program arguments passed after the main class',
        },
        stdin: {
          type: 'string',
          description: 'Text written to the process standard input',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Execution timeout in milliseconds (defaults to the plugin config)',
        },
        maxHeapMb: {
          type: 'integer',
          description: 'Java heap cap in MiB (defaults to the plugin config)',
        },
        release: {
          type: 'integer',
          description: 'Target Java release for javac --release when compiling',
        },
        classpath: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional classpath entries; relative entries resolve against the workspace root',
        },
        keepWorkdir: {
          type: 'boolean',
          description: 'Keep the scratch directory even when the program succeeds',
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
            signal: nullableString,
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            stdoutTruncated: { type: 'boolean', required: true },
            stderrTruncated: { type: 'boolean', required: true },
            durationMs: { type: 'number', required: true },
            main: { type: 'string', required: true },
            compile: compileSummarySchema,
            workdir: nullableString,
            retained: { type: 'boolean', required: true },
            retainedReason: nullableString,
            sandbox: sandboxFactsSchema,
            sandboxDenied: { type: 'boolean', required: true },
            runnerFailure: nullableString,
            stdoutSpillPath: nullableString,
            stderrSpillPath: nullableString,
          },
        },
        presentationMeta: (_args, value) => {
          const parts: string[] = []
          if (value.stdout !== '') parts.push(value.stdout)
          if (value.stderr !== '') parts.push(value.stderr)
          return {
            main: value.main,
            output: parts.join(value.stdout !== '' && value.stderr !== '' ? '\n' : ''),
            exitCode: value.exitCode,
            signal: value.signal,
            compileFailed: value.compile !== null && !value.compile.success,
          } satisfies RunMeta
        },
        render: (_args, value) => {
          const lines: string[] = []
          if (value.compile !== null && !value.compile.success) {
            const { errors, warnings } = countSeverities(value.compile.diagnostics)
            lines.push(
              `Compilation failed with ${errors} error(s)${
                warnings > 0 ? ` and ${warnings} warning(s)` : ''
              }`,
              '',
              renderDiagnostics(value.compile.diagnostics),
            )
            if (value.workdir !== null) {
              lines.push('', `Scratch directory kept at ${value.workdir}`)
            }
            return [{ type: 'text', text: lines.join('\n') }]
          }

          if (value.timedOut) {
            lines.push(`Execution timed out after ${value.durationMs} ms`)
          } else if (value.signal !== null) {
            lines.push(`Execution killed by ${value.signal} after ${value.durationMs} ms`)
          } else {
            lines.push(
              `Execution finished with exit code ${value.exitCode ?? 'unknown'} in ${value.durationMs} ms`,
            )
          }

          if (value.stdout !== '') {
            lines.push('', 'stdout:', clip(value.stdout, MODEL_STDOUT_LIMIT))
          }
          if (value.stderr !== '') {
            lines.push('', 'stderr:', clip(value.stderr, MODEL_STDERR_LIMIT))
          }
          const notes = truncationNote(
            value.stdoutTruncated,
            value.stderrTruncated,
            value.stdoutSpillPath,
            value.stderrSpillPath,
          )
          if (notes !== '') lines.push('', notes)
          if (value.sandboxDenied) {
            lines.push(
              '',
              'The sandbox denied a file effect; the program output above may reflect that.',
            )
          }
          if (value.runnerFailure !== null) {
            lines.push('', `Sandbox runner failure: ${value.runnerFailure}`)
          }
          if (value.retained && value.workdir !== null) {
            lines.push('', `Scratch directory kept at ${value.workdir}`)
          }
          if (lines.length === 0) lines.push('The program produced no output.')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: `java ${args.main}`,
        description:
          args.files !== undefined && args.files.length > 0
            ? `Compile ${args.files.length} source file(s), then run ${args.main}`
            : `Run ${args.main}`,
      }),
      presentResult: (_args, result) => {
        const meta = result.meta as unknown as RunMeta | undefined
        if (meta === undefined) return undefined
        if (meta.compileFailed) {
          return { card: 'generic', title: 'Compilation failed' }
        }
        return {
          card: 'terminal',
          title: `java ${meta.main}`,
          output: meta.output,
          ...(meta.exitCode === null ? {} : { exitCode: meta.exitCode }),
          ...(meta.signal === null ? {} : { signal: meta.signal }),
        }
      },
      async execute(args, exec) {
        const main = args.main.trim()
        if (!MAIN_CLASS.test(main)) {
          throw new Error(
            `main must be a valid fully qualified class name (for example "Main" or "com.example.Main"), got "${args.main}"`,
          )
        }
        const programArgs = args.args ?? []
        for (const argument of programArgs) {
          if (argument.includes('\0')) {
            throw new Error('Program arguments must not contain NUL bytes')
          }
        }

        const timeoutMs = args.timeoutMs ?? config.timeoutMs
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
          throw new Error('timeoutMs must be a positive number no greater than 600000')
        }
        const maxHeapMb = args.maxHeapMb ?? config.maxHeapMb
        if (!Number.isInteger(maxHeapMb) || maxHeapMb < 8 || maxHeapMb > 32_768) {
          throw new Error('maxHeapMb must be an integer between 8 and 32768')
        }
        const release = args.release
        if (release !== undefined && (release < 8 || release > 99)) {
          throw new Error(`release must be between 8 and 99, got ${release}`)
        }

        const policy = resolvePolicy(ctx, exec)
        const workspaceRoot = policy.workspaceRoot
        const scratch = await createScratch(
          workspaceRoot,
          config.scratchRoot,
          String(exec.callId),
        )
        const files = args.files as SourceFileRequest[] | undefined
        const classpath = resolveClasspath(args.classpath, workspaceRoot)
        const keepWorkdir = args.keepWorkdir ?? false

        try {
          const jdk = await resolver.require({
            workspaceRoot,
            signal: exec.signal,
          })

          let compileSummary: {
            success: boolean
            diagnostics: Diagnostic[]
            unknownLines: string[]
            coverage: number
            durationMs: number
            sandboxDenied: boolean
            runnerFailure: string | null
            outputTruncated: boolean
          } | null = null

          if (files !== undefined && files.length > 0) {
            const compiled = await compileJava({
              ctx,
              config,
              resolver,
              policy,
              exec,
              workspaceRoot,
              workdir: scratch.workdir,
              outDir: scratch.outDir,
              files,
              release,
              classpath,
            })
            compileSummary = {
              success: compiled.success,
              diagnostics: compiled.diagnostics,
              unknownLines: compiled.unknownLines,
              coverage: compiled.coverage,
              durationMs: compiled.durationMs,
              sandboxDenied: compiled.sandboxDenied,
              runnerFailure: compiled.runnerFailure,
              outputTruncated: compiled.outputTruncated,
            }

            if (!compiled.success) {
              const retention = decideRetention({
                keepWorkdir,
                success: false,
                truncated: compiled.outputTruncated,
                unknownLines: compiled.unknownLines.length,
              })
              if (!retention.retained) await removeScratch(scratch.workdir)
              return {
                success: false,
                timedOut: false,
                exitCode: null,
                signal: null,
                stdout: '',
                stderr: '',
                stdoutTruncated: false,
                stderrTruncated: false,
                durationMs: compiled.durationMs,
                main,
                compile: compileSummary,
                workdir: retention.retained ? scratch.workdir : null,
                retained: retention.retained,
                retainedReason: retention.reason,
                sandbox: compiled.sandbox,
                sandboxDenied: compiled.sandboxDenied,
                runnerFailure: compiled.runnerFailure,
                stdoutSpillPath: compiled.stdoutSpillPath,
                stderrSpillPath: compiled.stderrSpillPath,
              }
            }
          }

          const run = await runJava({
            ctx,
            policy,
            exec,
            jdk,
            workspaceRoot,
            workdir: scratch.workdir,
            outDir: compileSummary === null ? null : scratch.outDir,
            main,
            args: programArgs,
            stdin: args.stdin,
            timeoutMs,
            maxHeapMb,
            classpath,
          })

          const truncated = run.stdoutTruncated || run.stderrTruncated
          const success =
            run.exitCode === 0 &&
            !run.timedOut &&
            !run.sandboxDenied &&
            run.runnerFailure === null
          const retention = decideRetention({
            keepWorkdir,
            success,
            truncated,
            timedOut: run.timedOut,
          })
          if (!retention.retained) await removeScratch(scratch.workdir)

          return {
            success,
            timedOut: run.timedOut,
            exitCode: run.exitCode,
            signal: run.signal,
            stdout: run.stdout,
            stderr: run.stderr,
            stdoutTruncated: run.stdoutTruncated,
            stderrTruncated: run.stderrTruncated,
            durationMs: run.durationMs,
            main,
            compile: compileSummary,
            workdir: retention.retained ? scratch.workdir : null,
            retained: retention.retained,
            retainedReason: retention.reason,
            sandbox: run.sandbox,
            sandboxDenied: run.sandboxDenied,
            runnerFailure: run.runnerFailure,
            stdoutSpillPath: run.stdoutSpillPath,
            stderrSpillPath: run.stderrSpillPath,
          }
        } catch (error) {
          if (!keepWorkdir) {
            await removeScratch(scratch.workdir).catch(() => {})
          }
          throw error
        }
      },
    }),
  )
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n... (${text.length - limit} more characters; see the structured result)`
}
