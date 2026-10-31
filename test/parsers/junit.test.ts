import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseJunitReports } from '../../src/parsers/junit.js'

const fixtureDir = fileURLToPath(new URL('../fixtures/junit/', import.meta.url))
const directories: string[] = []

async function reportsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-junit-reports-'))
  directories.push(directory)
  await copyFile(
    join(fixtureDir, 'TEST-com.example.CalculatorTest.xml'),
    join(directory, 'TEST-com.example.CalculatorTest.xml'),
  )
  await copyFile(
    join(fixtureDir, 'TEST-com.example.UnicodeTest.xml'),
    join(directory, 'TEST-com.example.UnicodeTest.xml'),
  )
  await writeFile(join(directory, 'junit-platform.log'), 'not a report')
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('parseJunitReports', () => {
  it('summarizes passing, failing, erroring, and skipped cases', async () => {
    const summary = await parseJunitReports(await reportsDirectory())

    expect(summary.reportFiles).toBe(2)
    expect(summary.total).toBe(6)
    expect(summary.passed).toBe(2)
    expect(summary.failed).toBe(3)
    expect(summary.skipped).toBe(1)
  })

  it('extracts messages and stack traces, including errors', async () => {
    const summary = await parseJunitReports(await reportsDirectory())

    expect(summary.failures[0]).toMatchObject({
      test: 'com.example.CalculatorTest#subtracts()',
      message: 'expected: <2> but was: <3>',
    })
    expect(summary.failures[0]?.stackTrace).toContain('AssertionFailedError')
    expect(summary.failures[0]?.stackTrace).toContain('CalculatorTest.java:13')

    expect(summary.failures[1]).toMatchObject({
      test: 'com.example.CalculatorTest#divides()',
      message: '/ by zero',
    })
    expect(summary.failures[1]?.stackTrace).toContain('ArithmeticException')
  })

  it('keeps Unicode text and falls back to the first stack line', async () => {
    const summary = await parseJunitReports(await reportsDirectory())

    expect(summary.failures[2]).toMatchObject({
      test: 'com.example.UnicodeTest#显示名称()',
      message: '你好: 断言失败',
    })
    expect(summary.failures[2]?.stackTrace).toContain('UnicodeTest.java:9')
  })

  it('ignores system-out content inside a passing test case', async () => {
    const summary = await parseJunitReports(await reportsDirectory())

    expect(summary.failures.some((failure) => failure.test.endsWith('#adds()'))).toBe(false)
  })

  it('returns an empty summary for a missing directory', async () => {
    const summary = await parseJunitReports(join(tmpdir(), 'dsh-junit-missing-reports'))

    expect(summary).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      reportFiles: 0,
    })
  })
})
