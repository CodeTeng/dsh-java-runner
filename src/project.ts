import { constants } from 'node:fs'
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { normalizeRelativePath } from './inputs.js'
import type { JdkCandidate, JdkResolver } from './jdk.js'
import type { JunitFailure } from './parsers/junit.js'
import { parseJunitReportFiles } from './parsers/junit.js'
import { environmentFor, runProcess } from './proc.js'
import type { ProcessSandboxFacts } from './proc.js'

export type BuildSystem = 'maven' | 'gradle'
export type BuildSystemRequest = BuildSystem | 'auto'

export interface ProjectInfo {
  system: BuildSystem
  projectDir: string
  argv: string[]
  command: string
  wrapper: boolean
}

export interface ProjectTestOptions {
  ctx: Context
  resolver: JdkResolver
  policy: SandboxExecutionPolicy
  exec: ToolRunContext
  workspaceRoot: string
  project: ProjectInfo
  workdir: string
  timeoutMs: number
}

export interface ProjectTestResult {
  system: BuildSystem
  command: string
  projectDir: string
  wrapper: boolean
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  stdoutSpillPath: string | null
  stderrSpillPath: string | null
  durationMs: number
  timedOut: boolean
  total: number
  passed: number
  failed: number
  skipped: number
  failures: JunitFailure[]
  reportFiles: number
  sandbox: ProcessSandboxFacts | null
  sandboxDenied: boolean
  runnerFailure: string | null
  jdk: JdkCandidate
}

const GRADLE_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
const REPORT_DIRECTORIES = new Set(['surefire-reports', 'test-results'])
const SKIPPED_DIRECTORIES = new Set(['.git', '.gradle', '.dsh-java', 'node_modules'])
const MAX_REPORT_FILES = 2000
const MAX_SCAN_DEPTH = 8
const MAVEN_LOCALE_OPTS = '-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8'
const GRADLE_LOCALE_OPTS = '-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8'

export async function resolveProject(options: {
  ctx: Context
  workspaceRoot: string
  directory: string | undefined
  requested: BuildSystemRequest
  offline: boolean
}): Promise<ProjectInfo> {
  const projectDir = await resolveProjectDirectory(options.workspaceRoot, options.directory)
  const system = await detectBuildSystem(projectDir, options.requested)
  const args =
    system === 'maven'
      ? [
          '-B',
          '-q',
          '-ntp',
          '-Dstyle.color=never',
          ...(options.offline ? ['-o'] : []),
          'test',
        ]
      : [
          '--console=plain',
          '--no-daemon',
          ...(options.offline ? ['--offline'] : []),
          'test',
        ]
  const tool = system === 'maven' ? 'mvn' : 'gradle'
  const invocation = await buildInvocation(options.ctx, projectDir, system, tool, args)
  return {
    system,
    projectDir,
    argv: invocation.argv,
    command: `${tool} test`,
    wrapper: invocation.wrapper,
  }
}

export async function runProjectTest(options: ProjectTestOptions): Promise<ProjectTestResult> {
  const jdk = await options.resolver.require({
    workspaceRoot: options.workspaceRoot,
    signal: options.exec.signal,
  })
  const env: NodeJS.ProcessEnv = { ...environmentFor(jdk.home) }
  if (options.project.system === 'maven') env['MAVEN_OPTS'] = MAVEN_LOCALE_OPTS
  else env['GRADLE_OPTS'] = GRADLE_LOCALE_OPTS

  const result = await runProcess(options.ctx, {
    argv: options.project.argv,
    cwd: options.project.projectDir,
    env,
    timeoutMs: options.timeoutMs,
    signal: options.exec.signal,
    spillDir: options.workdir,
    policy: options.policy,
    stdoutMaxBytes: 512 * 1024,
    stderrMaxBytes: 256 * 1024,
  })
  options.exec.signal.throwIfAborted()

  const reportFiles = await findTestReportFiles(options.project.projectDir)
  const reports = await parseJunitReportFiles(reportFiles)

  return {
    system: options.project.system,
    command: options.project.command,
    projectDir: options.project.projectDir,
    wrapper: options.project.wrapper,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutSpillPath: result.stdoutSpillPath,
    stderrSpillPath: result.stderrSpillPath,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    total: reports.total,
    passed: reports.passed,
    failed: reports.failed,
    skipped: reports.skipped,
    failures: reports.failures,
    reportFiles: reports.reportFiles,
    sandbox: result.sandbox,
    sandboxDenied: result.sandboxDenied,
    runnerFailure: result.runnerFailure,
    jdk,
  }
}

export async function findTestReportFiles(root: string): Promise<string[]> {
  const files = new Set<string>()
  await walk(root, 0)
  return [...files].sort()

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || files.size >= MAX_REPORT_FILES) return
    const entries = await readDirectory(directory)
    for (const entry of entries) {
      if (files.size >= MAX_REPORT_FILES) return
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      const child = join(directory, entry.name)
      if (REPORT_DIRECTORIES.has(entry.name)) {
        await collect(child, 0)
      } else {
        await walk(child, depth + 1)
      }
    }
  }

  async function collect(directory: string, depth: number): Promise<void> {
    if (depth > 3 || files.size >= MAX_REPORT_FILES) return
    const entries = await readDirectory(directory)
    for (const entry of entries) {
      if (files.size >= MAX_REPORT_FILES) return
      if (entry.isSymbolicLink()) continue
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        await collect(child, depth + 1)
      } else if (entry.name.startsWith('TEST-') && entry.name.endsWith('.xml')) {
        files.add(child)
      }
    }
  }
}

async function resolveProjectDirectory(
  workspaceRoot: string,
  directory: string | undefined,
): Promise<string> {
  const raw = (directory ?? '.').replace(/\\/g, '/').trim()
  if (raw === '') throw new Error('directory must not be empty')
  if (raw.includes('\0')) throw new Error('directory must not contain NUL bytes')
  if (posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`directory "${directory}" must be workspace-relative, not absolute`)
  }

  const root = await realpath(resolve(workspaceRoot))
  const relativePath = raw === '.' ? '.' : normalizeRelativePath(raw)
  let projectDir: string
  try {
    projectDir = await realpath(resolve(root, relativePath))
  } catch {
    throw new Error(`Project directory "${raw}" was not found in the workspace`)
  }
  const rel = relative(root, projectDir)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Project directory "${raw}" escapes the workspace`)
  }
  const info = await stat(projectDir)
  if (!info.isDirectory()) throw new Error(`Project path "${raw}" is not a directory`)
  return projectDir
}

async function detectBuildSystem(
  projectDir: string,
  requested: BuildSystemRequest,
): Promise<BuildSystem> {
  const hasPom = await isFile(join(projectDir, 'pom.xml'))
  const gradleChecks = await Promise.all(
    GRADLE_FILES.map((name) => isFile(join(projectDir, name))),
  )
  const hasGradle = gradleChecks.some((present) => present)

  if (requested === 'maven') {
    if (!hasPom) throw new Error(`No pom.xml was found in ${projectDir}`)
    return 'maven'
  }
  if (requested === 'gradle') {
    if (!hasGradle) {
      throw new Error(`No Gradle build file was found in ${projectDir}`)
    }
    return 'gradle'
  }
  if (hasPom && hasGradle) {
    throw new Error(
      'Both pom.xml and a Gradle build file were found; pass system: "maven" or "gradle"',
    )
  }
  if (hasPom) return 'maven'
  if (hasGradle) return 'gradle'
  throw new Error(
    `No Maven or Gradle build was found in ${projectDir}. Add pom.xml or a Gradle build file, or use java_test for ad-hoc sources.`,
  )
}

async function buildInvocation(
  ctx: Context,
  projectDir: string,
  system: BuildSystem,
  tool: string,
  args: readonly string[],
): Promise<{ argv: string[]; wrapper: boolean }> {
  const wrapperName =
    process.platform === 'win32'
      ? system === 'maven'
        ? 'mvnw.cmd'
        : 'gradlew.bat'
      : system === 'maven'
        ? 'mvnw'
        : 'gradlew'
  const wrapper = join(projectDir, wrapperName)
  if (await isFile(wrapper)) {
    return {
      argv:
        process.platform === 'win32'
          ? windowsCommandLine(wrapper, args)
          : await posixScript(wrapper, args),
      wrapper: true,
    }
  }

  if (process.platform === 'win32') {
    const resolved = await resolveExecutable(ctx, tool)
    if (resolved !== null && /\.(?:exe|com)$/i.test(resolved)) {
      return { argv: [resolved, ...args], wrapper: false }
    }
    // mvn.cmd and gradle.bat are not directly spawnable; let cmd.exe apply PATHEXT.
    return { argv: windowsCommandLine(tool, args), wrapper: false }
  }

  const resolved = await resolveExecutable(ctx, tool)
  if (resolved === null) {
    throw new Error(
      `${tool} was not found. Add the ${wrapperName} wrapper to the project or install ${tool}.`,
    )
  }
  return { argv: [resolved, ...args], wrapper: false }
}

async function resolveExecutable(ctx: Context, name: string): Promise<string | null> {
  const subprocess = ctx.get('subprocess')
  if (!subprocess) return null
  try {
    return await subprocess.resolveExecutable(name)
  } catch {
    return null
  }
}

function windowsCommandLine(program: string, args: readonly string[]): string[] {
  const line = [program, ...args].map(quoteForCommandLine).join(' ')
  return [process.env['ComSpec'] ?? 'cmd.exe', '/d', '/s', '/c', line]
}

function quoteForCommandLine(value: string): string {
  if (value === '') return '""'
  return /[\s"&|<>^()%!]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

async function posixScript(path: string, args: readonly string[]): Promise<string[]> {
  try {
    await access(path, constants.X_OK)
    return [path, ...args]
  } catch {
    return ['/bin/sh', path, ...args]
  }
}

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}
