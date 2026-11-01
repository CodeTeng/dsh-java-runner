import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { createWorkdir, removeScratch } from '../inputs.js'
import type { JdkResolver } from '../jdk.js'
import type { JunitFailure } from '../parsers/junit.js'
import type { BuildSystem } from '../project.js'
import { resolveProject, runProjectTest } from '../project.js'
import {
  decideRetention,
  junitFailuresSchema,
  nullableNumber,
  nullableString,
  resolvePolicy,
  sandboxFactsSchema,
  truncationNote,
} from './shared.js'

interface ProjectTestMeta {
  system: BuildSystem
  total: number
  passed: number
  failed: number
  exitCode: number | null
  timedOut: boolean
  output: string
}

const MODEL_FAILURE_LIMIT = 10

export function registerProjectTestTool(
  ctx: Context,
  config: Config,
  resolver: JdkResolver,
): void {
  ctx.tools.register(
    defineTool({
      name: 'java_project_test',
      description:
        'Run the tests of an existing Maven or Gradle project by delegating to its build tool (mvnw/mvn or gradlew/gradle), then parse surefire/Gradle XML reports into totals and failures with stack traces. Use this when the project has a pom.xml or Gradle build file; use java_test for ad-hoc source files instead. The build runs in the project directory under the session sandbox with a resolver-selected JAVA_HOME and a longer default timeout.',
      parameters: {
        directory: {
          type: 'string',
          description:
            'Workspace-relative project directory containing pom.xml or a Gradle build file; defaults to the workspace root',
        },
        system: {
          type: 'string',
          enum: ['auto', 'maven', 'gradle'],
          description:
            'Build system; auto detects pom.xml or Gradle files and requires this when both exist',
        },
        offline: {
          type: 'boolean',
          description:
            'Run Maven with -o or Gradle with --offline; use when dependencies are already cached',
        },
        timeoutMs: {
          type: 'integer',
          description:
            'Build timeout in milliseconds (defaults to the plugin buildTimeoutMs config)',
        },
        keepWorkdir: {
          type: 'boolean',
          description: 'Keep the scratch/log directory even when the build succeeds',
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
            durationMs: { type: 'number', required: true },
            system: { type: 'string', enum: ['maven', 'gradle'], required: true },
            command: { type: 'string', required: true },
            projectDir: { type: 'string', required: true },
            wrapper: { type: 'boolean', required: true },
            jdkHome: { type: 'string', required: true },
            total: { type: 'number', required: true },
            passed: { type: 'number', required: true },
            failed: { type: 'number', required: true },
            skipped: { type: 'number', required: true },
            failures: junitFailuresSchema,
            reportFiles: { type: 'number', required: true },
            workdir: nullableString,
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
          },
        },
        presentationMeta: (_args, value) => ({
          system: value.system,
          total: value.total,
          passed: value.passed,
          failed: value.failed,
          exitCode: value.exitCode,
          timedOut: value.timedOut,
          output: preview(value),
        }) satisfies ProjectTestMeta,
        render: (_args, value) => {
          const lines: string[] = []
          const label = value.system === 'maven' ? 'Maven' : 'Gradle'
          if (value.timedOut) {
            lines.push(`${label} test run timed out after ${value.durationMs} ms`)
          } else {
            lines.push(
              `${label} test run (${value.command}) finished with exit code ${
                value.exitCode ?? 'unknown'
              } in ${value.durationMs} ms`,
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
              lines.push('', 'No test reports were parsed before the timeout.')
            } else if (value.exitCode === 0) {
              lines.push(
                '',
                'The build succeeded but no surefire/Gradle XML reports were parsed. Check that the project has tests and that report generation is enabled.',
              )
            } else {
              lines.push(
                '',
                'No test reports were parsed; the build most likely failed before running tests.',
              )
            }
          }

          if (value.stdout !== '' && (value.total === 0 || value.failed > 0 || value.timedOut)) {
            lines.push('', 'Build stdout (tail):', tail(value.stdout, 6000))
          }
          if (value.stderr !== '' && (value.total === 0 || value.failed > 0 || value.timedOut)) {
            lines.push('', 'Build stderr (tail):', tail(value.stderr, 4000))
          }

          const notes = truncationNote(
            value.stdoutTruncated,
            value.stderrTruncated,
            value.stdoutSpillPath,
            value.stderrSpillPath,
          )
          if (notes !== '') lines.push('', notes)
          if (value.sandboxDenied) {
            lines.push('', 'The sandbox denied a file effect; the build result may reflect that.')
          }
          if (value.runnerFailure !== null) {
            lines.push('', `Sandbox runner failure: ${value.runnerFailure}`)
          }
          if (value.reportFiles > 0) {
            lines.push('', `Parsed ${value.reportFiles} test report file(s).`)
          }
          if (value.retained && value.workdir !== null) {
            lines.push(`Scratch directory kept at ${value.workdir}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall: (args) => ({
        card: 'terminal',
        title:
          args.system === 'maven'
            ? 'mvn test'
            : args.system === 'gradle'
              ? 'gradle test'
              : 'Run project tests',
        description:
          args.directory === undefined || args.directory === '.'
            ? 'Run the project build tests'
            : `Run tests in ${args.directory}`,
      }),
      presentResult: (_args, result) => {
        const meta = result.meta as unknown as ProjectTestMeta | undefined
        if (meta === undefined) return undefined
        return {
          card: 'terminal',
          title: `${meta.system}: ${meta.passed} passed, ${meta.failed} failed`,
          output: meta.output,
          ...(meta.exitCode === null ? {} : { exitCode: meta.exitCode }),
        }
      },
      async execute(args, exec) {
        const timeoutMs = args.timeoutMs ?? config.buildTimeoutMs
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
          throw new Error('timeoutMs must be a positive number no greater than 600000')
        }

        const policy = resolvePolicy(ctx, exec)
        const workspaceRoot = policy.workspaceRoot
        const project = await resolveProject({
          ctx,
          workspaceRoot,
          directory: args.directory,
          requested: args.system ?? 'auto',
          offline: args.offline ?? false,
        })
        const workdir = await createWorkdir(
          workspaceRoot,
          config.scratchRoot,
          String(exec.callId),
        )
        const keepWorkdir = args.keepWorkdir ?? false

        try {
          const run = await runProjectTest({
            ctx,
            resolver,
            policy,
            exec,
            workspaceRoot,
            project,
            workdir,
            timeoutMs,
          })
          const truncated = run.stdoutTruncated || run.stderrTruncated
          const success =
            run.exitCode === 0 &&
            !run.timedOut &&
            !run.sandboxDenied &&
            run.runnerFailure === null &&
            run.failed === 0 &&
            run.total > 0
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
            signal: run.signal,
            durationMs: run.durationMs,
            system: run.system,
            command: run.command,
            projectDir: run.projectDir,
            wrapper: run.wrapper,
            jdkHome: run.jdk.home,
            total: run.total,
            passed: run.passed,
            failed: run.failed,
            skipped: run.skipped,
            failures: run.failures,
            reportFiles: run.reportFiles,
            workdir: retention.retained ? workdir : null,
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

function tail(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `... (${text.length - limit} earlier characters)\n${text.slice(text.length - limit)}`
}

function indent(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n')
}
