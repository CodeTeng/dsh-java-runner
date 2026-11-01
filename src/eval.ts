import { access, constants } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { DockerConfiguration, DockerFacts } from './docker.js'
import { createDockerPathMapper, runDocker, toContainerPath } from './docker.js'
import type { JdkCandidate } from './jdk.js'
import type { ProcessSandboxFacts } from './proc.js'
import { environmentFor, runProcess } from './proc.js'

export interface EvalOptions {
  ctx: Context
  policy: SandboxExecutionPolicy
  exec: ToolRunContext
  jdk: JdkCandidate | null
  workspaceRoot: string
  workdir: string
  scriptPath: string
  code: string
  classpath: readonly string[]
  timeoutMs: number
  maxHeapMb: number
  docker: DockerConfiguration | null
}

export interface EvalCoreResult {
  jshell: string
  docker: DockerFacts | null
  stdout: string
  stderr: string
  errors: string[]
  exitCode: number | null
  durationMs: number
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutSpillPath: string | null
  stderrSpillPath: string | null
  sandbox: ProcessSandboxFacts | null
  sandboxDenied: boolean
  runnerFailure: string | null
}

const ERROR_LINE = /^(?:\| {2})?(?:Error:|Exception\b.*)$/

export function jshellPath(jdk: JdkCandidate): string {
  const bin = jdk.javacPath === null ? join(jdk.home, 'bin') : dirname(jdk.javacPath)
  return join(bin, process.platform === 'win32' ? 'jshell.exe' : 'jshell')
}

export function jshellArgv(
  jshell: string,
  options: {
    scriptPath: string
    classpath: readonly string[]
    maxHeapMb: number
    classpathSeparator?: string
  },
): string[] {
  const argv = [jshell, '--feedback', 'concise']
  argv.push('-J-Xmx' + String(options.maxHeapMb) + 'm')
  for (const option of frontendOptions()) argv.push('-J' + option)
  argv.push('-R-Xmx' + String(options.maxHeapMb) + 'm')
  for (const option of runtimeOptions()) argv.push('-R' + option)
  if (options.classpath.length > 0) {
    argv.push(
      '--class-path',
      options.classpath.join(options.classpathSeparator ?? delimiter),
    )
  }
  argv.push(options.scriptPath)
  return argv
}

function frontendOptions(): string[] {
  return [
    '-Duser.language=en',
    '-Duser.country=US',
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
  ]
}

function runtimeOptions(): string[] {
  return [
    '-Duser.language=en',
    '-Duser.country=US',
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
  ]
}

export async function runJshell(options: EvalOptions): Promise<EvalCoreResult> {
  await writeFile(options.scriptPath, ensureTrailingNewline(options.code), 'utf8')

  let jshell: string
  let result
  let docker: DockerFacts | null = null
  if (options.docker !== null) {
    jshell = 'jshell'
    const mapper = createDockerPathMapper({
      workspaceRoot: options.workspaceRoot,
      workdir: options.workdir,
    })
    result = await runDocker({
      ctx: options.ctx,
      policy: options.policy,
      exec: options.exec,
      configuration: options.docker,
      mapper,
      argv: jshellArgv('jshell', {
        scriptPath: toContainerPath(mapper, options.scriptPath),
        classpath: options.classpath.map((entry) => toContainerPath(mapper, entry)),
        maxHeapMb: options.maxHeapMb,
        classpathSeparator: ':',
      }),
      timeoutMs: options.timeoutMs,
      stdoutMaxBytes: 256 * 1024,
      stderrMaxBytes: 256 * 1024,
    })
    docker = result.docker
  } else {
    if (options.jdk === null) {
      throw new Error('java_eval requires a JDK when Docker execution is not configured')
    }
    jshell = jshellPath(options.jdk)
    if (!(await isFile(jshell))) {
      throw new Error(
        `JShell was not found in ${options.jdk.home}. Install a full JDK (jshell ships with the JDK, not the JRE).`,
      )
    }
    result = await runProcess(options.ctx, {
      argv: jshellArgv(jshell, {
        scriptPath: options.scriptPath,
        classpath: options.classpath,
        maxHeapMb: options.maxHeapMb,
      }),
      cwd: options.workspaceRoot,
      env: environmentFor(options.jdk.home),
      timeoutMs: options.timeoutMs,
      signal: options.exec.signal,
      spillDir: options.workdir,
      policy: options.policy,
      stdoutMaxBytes: 256 * 1024,
      stderrMaxBytes: 256 * 1024,
    })
  }
  options.exec.signal.throwIfAborted()

  const stdout = cleanJshellOutput(result.stdout)
  const stderr = cleanJshellOutput(result.stderr)
  return {
    jshell,
    docker,
    stdout,
    stderr,
    errors: extractErrors(stderr),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutSpillPath: result.stdoutSpillPath,
    stderrSpillPath: result.stderrSpillPath,
    sandbox: result.sandbox,
    sandboxDenied: result.sandboxDenied,
    runnerFailure: result.runnerFailure,
  }
}

export function cleanJshellOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^\| {2}Welcome to JShell[^\n]*\n?/m, '')
    .replace(/^\| {2}For an introduction[^\n]*\n?/m, '')
    .replace(/^jshell> ?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

export function extractErrors(stderr: string): string[] {
  const errors: string[] = []
  for (const line of cleanJshellOutput(stderr).split('\n')) {
    const trimmed = line.trim()
    if (ERROR_LINE.test(trimmed)) errors.push(trimmed)
  }
  return errors
}

function ensureTrailingNewline(code: string): string {
  return code.endsWith('\n') ? code : `${code}\n`
}

async function isFile(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    access(path, constants.F_OK, (error) => resolve(error === null))
  })
}
