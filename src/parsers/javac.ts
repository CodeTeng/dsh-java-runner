export type DiagnosticSeverity = 'error' | 'warning' | 'note'

export interface Diagnostic {
  file: string | null
  line: number | null
  column: number | null
  severity: DiagnosticSeverity
  code: string
  message: string
}

export interface JavacParseResult {
  diagnostics: Diagnostic[]
  unknownLines: string[]
  coverage: number
}

const POSITIONED = /^(.*):(\d+):(\d+): (compiler\.(?:err|warn|note)\.[a-z0-9.]+):? ?(.*)$/
const FILELESS = /^- (compiler\.(?:err|warn|note)\.[a-z0-9.]+):? ?(.*)$/
const SUMMARY = /^\d+ (?:error|errors|warning|warnings|note|notes)$/

const MESSAGES: Record<string, string> = {
  'compiler.err.illegal.start.of.expr': 'illegal start of expression',
  'compiler.err.cant.resolve.location': 'cannot find symbol',
  'compiler.err.expected': 'expected token',
  'compiler.err.expected2': 'expected token',
  'compiler.err.not.stmt': 'not a statement',
  'compiler.err.class.public.should.be.in.file': 'public class must be declared in a file with the same name',
  'compiler.warn.raw.class.use': 'raw type use',
  'compiler.warn.path.element.not.found': 'classpath element not found',
}

function severityOf(code: string): DiagnosticSeverity {
  if (code.startsWith('compiler.err.')) return 'error'
  if (code.startsWith('compiler.warn.')) return 'warning'
  return 'note'
}

function messageOf(code: string, args: string): string {
  const base = MESSAGES[code] ?? code.replace(/^compiler\.(?:err|warn|note)\./, '').replace(/\./g, ' ')
  return args ? `${base}: ${args}` : base
}

export function parseJavacOutput(output: string): JavacParseResult {
  const diagnostics: Diagnostic[] = []
  const unknownLines: string[] = []
  let relevantLines = 0

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    if (SUMMARY.test(line.trim())) continue

    relevantLines += 1

    const positioned = POSITIONED.exec(line)
    if (positioned) {
      const [, file, lineText, columnText, code, args] = positioned
      if (file && lineText && columnText && code) {
        diagnostics.push({
          file,
          line: Number.parseInt(lineText, 10),
          column: Number.parseInt(columnText, 10),
          severity: severityOf(code),
          code,
          message: messageOf(code, args ?? ''),
        })
        continue
      }
    }

    const fileless = FILELESS.exec(line)
    if (fileless) {
      const [, code, args] = fileless
      if (code) {
        diagnostics.push({
          file: null,
          line: null,
          column: null,
          severity: severityOf(code),
          code,
          message: messageOf(code, args ?? ''),
        })
        continue
      }
    }

    unknownLines.push(line)
  }

  return {
    diagnostics,
    unknownLines,
    coverage: relevantLines === 0 ? 1 : (relevantLines - unknownLines.length) / relevantLines,
  }
}
