import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { compileJava, resolveClasspath } from '../compile.js'
import type { SourceFileRequest } from '../inputs.js'
import { createScratch, removeScratch } from '../inputs.js'
import type { JdkResolver } from '../jdk.js'
import {
  compileResultProperties,
  countSeverities,
  decideRetention,
  renderDiagnostics,
  resolvePolicy,
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

export function registerCompileTool(
  ctx: Context,
  config: Config,
  resolver: JdkResolver,
): void {
  ctx.tools.register(
    defineTool({
      name: 'java_compile',
      description:
        'Compile Java source files with the resolved JDK and return structured diagnostics (file, line, column, severity, code, message) instead of raw javac output. Sources are inline content or workspace-relative paths; they are copied into a per-call scratch directory before compiling. Use this to type-check generated Java without executing it. Prefer this over "javac" in a shell: diagnostics are parsed, locale-stable, and UTF-8 safe.',
      parameters: {
        files: {
          ...filesSchema,
          description: 'One or more Java source files to compile',
        },
        release: {
          type: 'integer',
          description: 'Target Java release for javac --release (for example 17)',
        },
        classpath: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional classpath entries; relative entries resolve against the workspace root',
        },
        keepWorkdir: {
          type: 'boolean',
          description: 'Keep the scratch directory even when compilation succeeds',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: compileResultProperties,
        },
        render: (_args, value) => {
          const { errors, warnings } = countSeverities(value.diagnostics)
          const lines: string[] = []
          if (value.success) {
            lines.push(`Compilation succeeded in ${value.durationMs} ms`)
            if (warnings > 0) lines.push(`${warnings} warning(s)`)
          } else {
            lines.push(
              `Compilation failed in ${value.durationMs} ms with ${errors} error(s)${
                warnings > 0 ? ` and ${warnings} warning(s)` : ''
              }`,
            )
          }
          if (value.diagnostics.length > 0) {
            lines.push('', renderDiagnostics(value.diagnostics))
          }
          if (value.unknownLines.length > 0) {
            lines.push(
              '',
              `${value.unknownLines.length} unclassified output line(s) (coverage ${(
                value.coverage * 100
              ).toFixed(0)}%):`,
              ...value.unknownLines.slice(0, 10),
            )
          }
          if (value.sandboxDenied) {
            lines.push('', 'The sandbox denied a file effect; see stderr for the host message.')
          }
          if (value.runnerFailure !== null) {
            lines.push('', `Sandbox runner failure: ${value.runnerFailure}`)
          }
          if (value.outputTruncated) {
            const spills = [value.stdoutSpillPath, value.stderrSpillPath]
              .filter((path): path is string => path !== null)
              .join(', ')
            lines.push(
              '',
              `Compiler output was truncated${spills === '' ? '' : `; full stream: ${spills}`}`,
            )
          }
          if (value.retained && value.workdir !== null) {
            lines.push('', `Scratch directory kept at ${value.workdir}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `javac: ${args.files.length} source file(s)`,
        kind: 'execute',
      }),
      async execute(args, exec) {
        if (args.files.length === 0) {
          throw new Error('java_compile requires at least one source file')
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

        try {
          const core = await compileJava({
            ctx,
            config,
            resolver,
            policy,
            exec,
            workspaceRoot,
            workdir: scratch.workdir,
            outDir: scratch.outDir,
            files: args.files as SourceFileRequest[],
            release,
            classpath: resolveClasspath(args.classpath, workspaceRoot),
          })
          const retention = decideRetention({
            keepWorkdir: args.keepWorkdir ?? false,
            success: core.success,
            truncated: core.outputTruncated,
            unknownLines: core.unknownLines.length,
          })
          if (!retention.retained) await removeScratch(scratch.workdir)

          return {
            success: core.success,
            exitCode: core.exitCode,
            diagnostics: core.diagnostics,
            unknownLines: core.unknownLines,
            coverage: core.coverage,
            durationMs: core.durationMs,
            workdir: retention.retained ? scratch.workdir : null,
            outDir: retention.retained ? scratch.outDir : null,
            retained: retention.retained,
            retainedReason: retention.reason,
            sandbox: core.sandbox,
            sandboxDenied: core.sandboxDenied,
            runnerFailure: core.runnerFailure,
            outputTruncated: core.outputTruncated,
            stdoutSpillPath: core.stdoutSpillPath,
            stderrSpillPath: core.stderrSpillPath,
          }
        } catch (error) {
          if (args.keepWorkdir !== true) {
            await removeScratch(scratch.workdir).catch(() => {})
          }
          throw error
        }
      },
    }),
  )
}
