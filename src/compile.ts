import { delimiter, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'
import type { JdkCandidate, JdkResolver } from './jdk.js'
import type { SourceFileRequest } from './inputs.js'
import { materializeFiles, displayPath } from './inputs.js'
import { parseJavacOutput } from './parsers/javac.js'
import type { Diagnostic } from './parsers/javac.js'
import { environmentFor, runProcess } from './proc.js'
import type { ProcessSandboxFacts } from './proc.js'

export interface CompileOptions {
  ctx: Context
  config: Config
  resolver: JdkResolver
  policy: SandboxExecutionPolicy
  exec: ToolRunContext
  workspaceRoot: string
  workdir: string
  outDir: string
  files: readonly SourceFileRequest[]
  release?: number
  classpath?: readonly string[]
}

export interface CompileCoreResult {
  success: boolean
  exitCode: number | null
  diagnostics: Diagnostic[]
  unknownLines: string[]
  coverage: number
  durationMs: number
  sandbox: ProcessSandboxFacts | null
  sandboxDenied: boolean
  runnerFailure: string | null
  outputTruncated: boolean
  stdoutSpillPath: string | null
  stderrSpillPath: string | null
  jdk: JdkCandidate
}

export function javacArgv(
  jdk: JdkCandidate,
  options: {
    outDir: string
    sources: readonly string[]
    release?: number
    classpath?: readonly string[]
  },
): string[] {
  const argv = [
    jdk.javacPath ?? 'javac',
    '-encoding',
    'UTF-8',
    '-XDrawDiagnostics',
    '-J-Duser.language=en',
    '-J-Duser.country=US',
    '-J-Dfile.encoding=UTF-8',
    '-J-Dstdout.encoding=UTF-8',
    '-J-Dstderr.encoding=UTF-8',
    '-J-Dsun.stdout.encoding=UTF-8',
    '-J-Dsun.stderr.encoding=UTF-8',
    '-d',
    options.outDir,
  ]
  if (options.classpath && options.classpath.length > 0) {
    argv.push('-cp', options.classpath.join(delimiter))
  }
  if (options.release !== undefined) {
    argv.push('--release', String(options.release))
  }
  argv.push(...options.sources)
  return argv
}

export async function compileJava(options: CompileOptions): Promise<CompileCoreResult> {
  const jdk = await options.resolver.require({
    workspaceRoot: options.workspaceRoot,
    signal: options.exec.signal,
  })
  const materialized = await materializeFiles(
    options.workspaceRoot,
    options.workdir,
    options.files,
  )
  const sources = materialized.map((file) => file.absolutePath)
  const argv = javacArgv(jdk, {
    outDir: options.outDir,
    sources,
    release: options.release,
    classpath: options.classpath,
  })

  const result = await runProcess(options.ctx, {
    argv,
    cwd: options.workdir,
    env: environmentFor(jdk.home),
    timeoutMs: options.config.timeoutMs,
    signal: options.exec.signal,
    spillDir: options.workdir,
    policy: options.policy,
    stdoutMaxBytes: 128 * 1024,
    stderrMaxBytes: 512 * 1024,
  })
  options.exec.signal.throwIfAborted()

  const parsed = parseJavacOutput(`${result.stderr}\n${result.stdout}`)
  const diagnostics = parsed.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    file: diagnostic.file === null ? null : displayPath(diagnostic.file, options.workdir),
  }))
  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === 'error')

  return {
    success: result.exitCode === 0 && !hasErrors,
    exitCode: result.exitCode,
    diagnostics,
    unknownLines: parsed.unknownLines,
    coverage: parsed.coverage,
    durationMs: result.durationMs,
    sandbox: result.sandbox,
    sandboxDenied: result.sandboxDenied,
    runnerFailure: result.runnerFailure,
    outputTruncated: result.stdoutTruncated || result.stderrTruncated,
    stdoutSpillPath: result.stdoutSpillPath,
    stderrSpillPath: result.stderrSpillPath,
    jdk,
  }
}

export function resolveClasspath(
  entries: readonly string[] | undefined,
  workspaceRoot: string,
): string[] {
  if (entries === undefined) return []
  return entries.map((entry) => {
    const trimmed = entry.trim()
    if (trimmed === '') throw new Error('Classpath entries must not be empty')
    if (trimmed.includes('\0')) throw new Error('Classpath entries must not contain NUL bytes')
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || isAbsolute(trimmed)) return trimmed
    return resolve(workspaceRoot, trimmed)
  })
}
