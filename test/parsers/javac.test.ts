import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseJavacOutput } from '../../src/parsers/javac.js'

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/javac/${name}`, import.meta.url), 'utf8')
}

describe('parseJavacOutput', () => {
  it('parses positioned errors and warnings', () => {
    const result = parseJavacOutput(fixture('errors.txt'))

    expect(result.unknownLines).toEqual([])
    expect(result.coverage).toBe(1)
    expect(result.diagnostics).toHaveLength(4)

    expect(result.diagnostics[0]).toEqual({
      file: 'Bad.java',
      line: 1,
      column: 65,
      severity: 'error',
      code: 'compiler.err.illegal.start.of.expr',
      message: 'illegal start of expression',
    })

    expect(result.diagnostics[1]).toMatchObject({
      file: 'Miss.java',
      line: 1,
      column: 39,
      severity: 'error',
      code: 'compiler.err.cant.resolve.location',
    })
    expect(result.diagnostics[1]?.message).toContain('cannot find symbol')
    expect(result.diagnostics[1]?.message).toContain('foo')
  })

  it('parses a file-less warning', () => {
    const result = parseJavacOutput(fixture('errors.txt'))
    const fileless = result.diagnostics.find((d) => d.file === null)

    expect(fileless).toMatchObject({
      file: null,
      line: null,
      column: null,
      severity: 'warning',
      code: 'compiler.warn.path.element.not.found',
    })
    expect(fileless?.message).toContain('dt.jar')
  })

  it('keeps a Windows drive path intact', () => {
    const output = 'C:\\work\\src\\Main.java:3:5: compiler.err.expected: token.identifier\n'
    const result = parseJavacOutput(output)

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      file: 'C:\\work\\src\\Main.java',
      line: 3,
      column: 5,
      severity: 'error',
      code: 'compiler.err.expected',
    })
  })

  it('returns full coverage for clean output', () => {
    expect(parseJavacOutput('')).toEqual({ diagnostics: [], unknownLines: [], coverage: 1 })
  })

  it('surfaces unparsed lines instead of treating them as success', () => {
    const output = [
      'Something unexpected',
      'Bad.java:1:2: compiler.err.expected: token.identifier',
    ].join('\n')

    const result = parseJavacOutput(output)

    expect(result.diagnostics).toHaveLength(1)
    expect(result.unknownLines).toEqual(['Something unexpected'])
    expect(result.coverage).toBe(0.5)
  })
})
