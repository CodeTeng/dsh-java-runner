import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface DiagnosticLike {
  file: string | null
  line: number | null
  column: number | null
  severity: string
  code: string
  message: string
}

interface AgentWithSession {
  session?: {
    id: string
    header: { cwd: string | null }
  }
}

export function resolvePolicy(ctx: Context, exec: ToolRunContext): SandboxExecutionPolicy {
  const service = ctx.get('sandboxPolicy')
  const agent = exec.agent as AgentWithSession | undefined
  const session = agent?.session
  if (service === undefined) {
    return {
      mode: 'danger-full-access',
      workspaceRoot: process.cwd(),
    }
  }
  return service.resolve(
    session === undefined ? {} : { session: session as never },
  )
}

export const nullableString = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
  required: true,
} as const

export const nullableNumber = {
  oneOf: [{ type: 'number' }, { type: 'null' }],
  required: true,
} as const

export const sandboxFactsSchema = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', required: true },
        enforcement: { type: 'string', required: true },
      },
    },
  ],
  required: true,
} as const

export const diagnosticsSchema = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file: nullableString,
      line: nullableNumber,
      column: nullableNumber,
      severity: { type: 'string', required: true },
      code: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
  },
} as const

export const compileResultProperties = {
  success: { type: 'boolean', required: true },
  exitCode: nullableNumber,
  diagnostics: diagnosticsSchema,
  unknownLines: { type: 'array', items: { type: 'string' }, required: true },
  coverage: { type: 'number', required: true },
  durationMs: { type: 'number', required: true },
  workdir: nullableString,
  outDir: nullableString,
  retained: { type: 'boolean', required: true },
  retainedReason: nullableString,
  sandbox: sandboxFactsSchema,
  sandboxDenied: { type: 'boolean', required: true },
  runnerFailure: nullableString,
  outputTruncated: { type: 'boolean', required: true },
  stdoutSpillPath: nullableString,
  stderrSpillPath: nullableString,
} as const

export const compileSummarySchema = {
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

export interface RetentionInput {
  keepWorkdir: boolean
  success: boolean
  truncated?: boolean
  unknownLines?: number
  timedOut?: boolean
}

export function decideRetention(input: RetentionInput): {
  retained: boolean
  reason: string | null
} {
  if (input.keepWorkdir) return { retained: true, reason: 'keepWorkdir was set' }
  if (!input.success) return { retained: true, reason: 'the call did not succeed' }
  if (input.timedOut === true) return { retained: true, reason: 'the process timed out' }
  if (input.truncated === true) {
    return { retained: true, reason: 'output was truncated; the spill file is kept' }
  }
  if ((input.unknownLines ?? 0) > 0) {
    return { retained: true, reason: 'compiler output contained unclassified lines' }
  }
  return { retained: false, reason: null }
}

export function renderDiagnostics(
  diagnostics: readonly DiagnosticLike[],
  limit = 40,
): string {
  const lines = diagnostics.slice(0, limit).map((diagnostic) => {
    const location =
      diagnostic.file === null
        ? ''
        : `${diagnostic.file}${diagnostic.line === null ? '' : `:${diagnostic.line}`}${
            diagnostic.column === null ? '' : `:${diagnostic.column}`
          }: `
    return `${location}${diagnostic.severity}: ${diagnostic.message} [${diagnostic.code}]`
  })
  if (diagnostics.length > limit) {
    lines.push(`... ${diagnostics.length - limit} more diagnostic(s) in the structured result`)
  }
  return lines.join('\n')
}

export function countSeverities(diagnostics: readonly DiagnosticLike[]): {
  errors: number
  warnings: number
} {
  let errors = 0
  let warnings = 0
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors += 1
    else if (diagnostic.severity === 'warning') warnings += 1
  }
  return { errors, warnings }
}

export function truncationNote(
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
  stdoutSpillPath: string | null,
  stderrSpillPath: string | null,
): string {
  const notes: string[] = []
  if (stdoutTruncated) {
    notes.push(`stdout was truncated${stdoutSpillPath ? ` (full stream: ${stdoutSpillPath})` : ''}`)
  }
  if (stderrTruncated) {
    notes.push(`stderr was truncated${stderrSpillPath ? ` (full stream: ${stderrSpillPath})` : ''}`)
  }
  return notes.join('\n')
}
