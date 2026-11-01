import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface JunitFailure {
  test: string
  message: string
  stackTrace: string
}

export interface JunitReportSummary {
  total: number
  passed: number
  failed: number
  skipped: number
  failures: JunitFailure[]
  reportFiles: number
}

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
const OUTCOME = /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/i
const ATTRIBUTE = /\b([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g

export async function parseJunitReports(directory: string): Promise<JunitReportSummary> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return emptySummary()
  }
  return parseJunitReportFiles(
    names
      .filter((name) => name.startsWith('TEST-') && name.endsWith('.xml'))
      .sort()
      .map((name) => join(directory, name)),
  )
}

export async function parseJunitReportFiles(
  files: readonly string[],
): Promise<JunitReportSummary> {
  const summary = emptySummary()
  for (const file of [...files].sort()) {
    let xml: string
    try {
      xml = await readFile(file, 'utf8')
    } catch {
      continue
    }
    summary.reportFiles += 1
    for (const testcase of parseTestcases(xml)) {
      summary.total += 1
      if (testcase.outcome === 'skipped') {
        summary.skipped += 1
      } else if (testcase.outcome === 'failure') {
        summary.failed += 1
        summary.failures.push({
          test: testcase.test,
          message: testcase.message,
          stackTrace: testcase.stackTrace,
        })
      } else {
        summary.passed += 1
      }
    }
  }
  return summary
}

function emptySummary(): JunitReportSummary {
  return { total: 0, passed: 0, failed: 0, skipped: 0, failures: [], reportFiles: 0 }
}

interface ParsedTestcase {
  test: string
  outcome: 'passed' | 'failure' | 'skipped'
  message: string
  stackTrace: string
}

function parseTestcases(xml: string): ParsedTestcase[] {
  const parsed: ParsedTestcase[] = []
  for (const match of xml.matchAll(TESTCASE)) {
    const attributes = parseAttributes(match[1] ?? '')
    const name = attributes.name ?? ''
    const classname = attributes.classname ?? ''
    const test = classname === '' ? name : `${classname}#${name}`
    const body = match[2] ?? ''
    const outcome = OUTCOME.exec(body)

    if (outcome === null) {
      parsed.push({ test, outcome: 'passed', message: '', stackTrace: '' })
      continue
    }

    const kind = outcome[1]?.toLowerCase()
    if (kind === 'skipped') {
      parsed.push({ test, outcome: 'skipped', message: '', stackTrace: '' })
      continue
    }

    const outcomeAttributes = parseAttributes(outcome[2] ?? '')
    const stackTrace = cleanText(outcome[3] ?? '')
    const message = cleanText(outcomeAttributes.message ?? '') || firstLine(stackTrace)
    parsed.push({ test, outcome: 'failure', message, stackTrace })
  }
  return parsed
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(ATTRIBUTE)) {
    const key = match[1]
    if (key !== undefined) attributes[key] = decodeXml(match[2] ?? '')
  }
  return attributes
}

function cleanText(source: string): string {
  const withoutCdata = source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  return decodeXml(withoutCdata).trim()
}

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) =>
      codePoint(Number.parseInt(value, 16)),
    )
    .replace(/&#(\d+);/g, (_match, value: string) => codePoint(Number(value)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function codePoint(value: number): string {
  return Number.isFinite(value) ? String.fromCodePoint(value) : ''
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? ''
}
