import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { compileJava, resolveClasspath } from '../compile.js'
import { dockerConfiguration } from '../docker.js'
import type { JunitFailure } from '../parsers/junit.js'
import type { SourceFileRequest } from '../inputs.js'
import { createScratch, removeScratch } from '../inputs.js'
import type { JdkResolver } from '../jdk.js'
import type { JunitJar } from '../junit-jar.js'
import { resolveJunitJar } from '../junit-jar.js'
import { runJunit } from '../junit.js'
import {
  compileSummarySchema,
  decideRetention,
  dockerFactsSchema,
  junitFailuresSchema,
  nullableNumber,
  nullableString,
  renderDiagnostics,
  resolvePolicy,
  sandboxFactsSchema,
  truncationNote,
} from './shared.js'

const filesSchema = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        required: true,
        description: 'Workspace-relative source path, for example "src/Main.java"',
      },
      content: {
        type: 'string',
        description: 'Inline source text; when omitted the file is read from the workspace',
      },
    },
  },
} as const

const jarSchema = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    path: { type: 'string', required: true },
    version: nullableString,
    source: { type: 'string', required: true },
  },
} as const

interface TestMeta {
  compileFailed: boolean
  total: number
  passed: number
  failed: number
  output: string
  exitCode: number | null
}

const MODEL_STDOUT_LIMIT = 16_000
const MODEL_FAILURE_LIMIT = 10

export function registerTestTool(
  ctx: Context,
  config: Config,
  resolver: JdkResolver,
): void {
  ctx.tools.register(
    defineTool({
      name: 'java_test',
      description:
        'Compile Java sources together with a JUnit console jar, run the tests, and return structured results (totals and failures with stack traces). The jar comes from the junitJarPath config, then ~/.m2, then a SHA-256 verified download; tests run in the session workspace with a heap cap and timeout under the sandbox policy. Prefer this over running JUnit by hand: classpath assembly, report parsing, and failure extraction are handled once.',
      parameters: {
        files: {
          ...filesSchema,
          description: 'Production and test sources to compile before running',
        },
        tests: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional selectors: "com.example.FooTests" or "com.example.FooTests#method"; omit to scan the classpath',
        },
        classpath: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional classpath entries; relative entries resolve against the workspace root',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Test run timeout in milliseconds (defaults to the plugin config)',
        },
        maxHeapMb: {
          type: 'integer',
          description: 'Java heap cap in MiB (defaults to the plugin config)',
        },
        release: {
          type: 'integer',
          description: 'Target Java release for javac --release when compiling',
        },
        keepWorkdir: {
          type: 'boolean',
          description: 'Keep the scratch directory even when the tests succeed',
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
            total: { type: 'number', required: true },
            passed: { type: 'number', required: true },
            failed: { type: 'number', required: true },
            skipped: { type: 'number', required: true },
            failures: junitFailuresSchema,
            reportFiles: { type: 'number', required: true },
            compile: compileSummarySchema,
            jar: jarSchema,
            reportsDir: nullableString,
            workdir: nullableString,
            outDir: nullableString,
            retained: { type: 'boolean', required: true },
            retainedReason: nullableString,
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
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
          compileFailed: value.compile !== null && !value.compile.success,
          total: value.total,
          passed: value.passed,
          failed: value.failed,
          output: preview(value),
          exitCode: value.exitCode,
        }) satisfies TestMeta,
        render: (_args, value) => {
          if (value.compile !== null && !value.compile.success) {
            const errors = value.compile.diagnostics.filter(
              (diagnostic) => diagnostic.severity === 'error',
            ).length
            const warnings = value.compile.diagnostics.filter(
              (diagnostic) => diagnostic.severity === 'warning',
            ).length
            const lines = [
              `Compilation failed with ${errors} error(s)${
                warnings > 0 ? ` and ${warnings} warning(s)` : ''
              }`,
              '',
              renderDiagnostics(value.compile.diagnostics),
            ]
            if (value.workdir !== null) {
              lines.push('', `Scratch directory kept at ${value.workdir}`)
              if (value.outDir !== null) lines.push(`Class files: ${value.outDir}`)
            }
            return [{ type: 'text', text: lines.join('\n') }]
          }

          const lines: string[] = []
          if (value.timedOut) {
            lines.push(`Test run timed out after ${value.durationMs} ms`)
          } else {
            lines.push(
              `Test run finished with exit code ${value.exitCode ?? 'unknown'} in ${value.durationMs} ms`,
            )
          }
          lines.push(
            '',
            `Tests: ${value.total} total, ${value.passed} passed, ${value.failed} failed, ${value.skipped} skipped`,
          )

          if (value.failures.length > 0) {
            lines.push('', 'Failures:')
            for (const failure of value.failures.slice(0, MODEL_FAILURE_LIMIT)) {
              lines.push(`- ${failure.test}: ${failure.message}`)
              if (failure.stackTrace !== '') {
                lines.push(indent(clip(failure.stackTrace, 2000), '    '))
              }
            }
            if (value.failures.length > MODEL_FAILURE_LIMIT) {
              lines.push(
                `... ${value.failures.length - MODEL_FAILURE_LIMIT} more failure(s) in the structured result`,
              )
            }
          }

          if (value.total === 0) {
            if (value.timedOut) {
              lines.push('', 'No tests were reported before the timeout.')
            } else if (value.exitCode === 0) {
              lines.push(
                '',
                'JUnit exited successfully but no test reports were parsed; see the console output below.',
              )
            } else {
              lines.push(
                '',
                'No tests were discovered. Test classes must match the console default pattern (Test*, *Test, *Tests), or pass `tests` selectors.',
              )
            }
          }

          if (value.stdout !== '' && (value.total === 0 || value.timedOut)) {
            lines.push('', 'JUnit output:', clip(value.stdout, 4000))
          }
          if (value.stderr !== '') {
            lines.push('', 'JUnit stderr:', clip(value.stderr, 4000))
          }

          const notes = truncationNote(
            value.stdoutTruncated,
            value.stderrTruncated,
            value.stdoutSpillPath,
            value.stderrSpillPath,
          )
          if (notes !== '') lines.push('', notes)
          if (value.compile !== null && value.compile.unknownLines.length > 0) {
            lines.push(
              '',
              `${value.compile.unknownLines.length} compiler output line(s) were not classified; see the structured compile summary.`,
            )
          }
          if (value.sandboxDenied) {
            lines.push('', 'The sandbox denied a file effect; the test results above may reflect that.')
          }
          if (value.runnerFailure !== null) {
            lines.push('', `Sandbox runner failure: ${value.runnerFailure}`)
          }
          if (value.docker !== null) {
            lines.push(
              '',
              `Docker: ${value.docker.image} (network ${value.docker.network}, container ${value.docker.container})`,
            )
          }
          lines.push('', `JUnit console: ${value.jar.path} (${value.jar.source})`)
          if (value.retained && value.workdir !== null) {
            lines.push(`Scratch directory kept at ${value.workdir}`)
            if (value.outDir !== null) lines.push(`Class files: ${value.outDir}`)
            if (value.reportsDir !== null) lines.push(`Reports: ${value.reportsDir}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Run JUnit tests: ${args.files.length} source file(s)`,
        kind: 'execute',
      }),
      presentResult: (_args, result) => {
        const meta = result.meta as unknown as TestMeta | undefined
        if (meta === undefined) return undefined
        if (meta.compileFailed) {
          return { card: 'generic', title: 'Compilation failed' }
        }
        return {
          card: 'terminal',
          title: `junit: ${meta.passed} passed, ${meta.failed} failed`,
          output: meta.output,
          ...(meta.exitCode === null ? {} : { exitCode: meta.exitCode }),
        }
      },
      async execute(args, exec) {
        if (args.files.length === 0) {
          throw new Error('java_test requires at least one source file')
        }
        const tests = (args.tests ?? []).map((test) => test.trim())
        for (const test of tests) {
          if (test === '') throw new Error('Test selectors must not be empty')
          if (test.includes('\0')) throw new Error('Test selectors must not contain NUL bytes')
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
        const docker = dockerConfiguration(config)
        const classpath = resolveClasspath(args.classpath, workspaceRoot)
        const keepWorkdir = args.keepWorkdir ?? false
        const jar = await resolveJunitJar(config, exec.signal)
        const scratch = await createScratch(
          workspaceRoot,
          config.scratchRoot,
          String(exec.callId),
        )
        const files = args.files as SourceFileRequest[]

        try {
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
            classpath: [jar.path, ...classpath],
          })
          const compileSummary = {
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
              durationMs: compiled.durationMs,
              total: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
              failures: [] as JunitFailure[],
              reportFiles: 0,
              compile: compileSummary,
              jar,
              reportsDir: null,
              workdir: retention.retained ? scratch.workdir : null,
              outDir: retention.retained ? scratch.outDir : null,
              retained: retention.retained,
              retainedReason: retention.reason,
              stdout: '',
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutSpillPath: compiled.stdoutSpillPath,
              stderrSpillPath: compiled.stderrSpillPath,
              sandbox: compiled.sandbox,
              sandboxDenied: compiled.sandboxDenied,
              runnerFailure: compiled.runnerFailure,
              docker: null,
            }
          }

          const run = await runJunit({
            ctx,
            policy,
            exec,
            jdk: compiled.jdk,
            workspaceRoot,
            workdir: scratch.workdir,
            outDir: scratch.outDir,
            jarPath: jar.path,
            classpath,
            tests,
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
            run.total > 0
          const retention = decideRetention({
            keepWorkdir,
            success,
            truncated,
            timedOut: run.timedOut,
            unknownLines: compiled.unknownLines.length,
          })
          if (!retention.retained) await removeScratch(scratch.workdir)

          return {
            success,
            timedOut: run.timedOut,
            exitCode: run.exitCode,
            durationMs: run.durationMs,
            total: run.total,
            passed: run.passed,
            failed: run.failed,
            skipped: run.skipped,
            failures: run.failures,
            reportFiles: run.reportFiles,
            compile: compileSummary,
            jar,
            reportsDir: retention.retained ? run.reportsDir : null,
            workdir: retention.retained ? scratch.workdir : null,
            outDir: retention.retained ? scratch.outDir : null,
            retained: retention.retained,
            retainedReason: retention.reason,
            stdout: run.stdout,
            stderr: run.stderr,
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
          if (!keepWorkdir) {
            await removeScratch(scratch.workdir).catch(() => {})
          }
          throw error
        }
      },
    }),
  )
}

function preview(value: {
  total: number
  passed: number
  failed: number
  skipped: number
  failures: readonly JunitFailure[]
  timedOut: boolean
}): string {
  const lines = [
    `${value.total} total, ${value.passed} passed, ${value.failed} failed, ${value.skipped} skipped${
      value.timedOut ? ' (timed out)' : ''
    }`,
  ]
  for (const failure of value.failures.slice(0, 2)) {
    lines.push(`${failure.test}: ${failure.message}`)
  }
  if (value.failures.length > 2) {
    lines.push(`... ${value.failures.length - 2} more failure(s)`)
  }
  return lines.join('\n')
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n... (${text.length - limit} more characters)`
}

function indent(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n')
}
