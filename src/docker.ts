import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'
import type { ProcessResult } from './proc.js'
import { runProcess } from './proc.js'

export interface DockerConfiguration {
  image: string
  network: 'none' | 'bridge'
}

export interface DockerFacts {
  image: string
  network: string
  container: string
}

export interface DockerPathMapper {
  workspaceRoot: string
  workdir: string
  junitJar: string | undefined
  extras: Map<string, { host: string; target: string }>
  next: number
}

export interface DockerRunOptions {
  ctx: Context
  policy: SandboxExecutionPolicy
  exec: ToolRunContext
  configuration: DockerConfiguration
  mapper: DockerPathMapper
  argv: readonly string[]
  stdin?: string
  timeoutMs: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
}

export interface DockerRunResult extends ProcessResult {
  docker: DockerFacts
}

export const CONTAINER_WORKSPACE = '/workspace'
export const CONTAINER_WORKDIR = '/dsh-work'
export const CONTAINER_JUNIT = '/dsh-libs/junit.jar'

export function dockerConfiguration(config: Config): DockerConfiguration | null {
  if (config.dockerImage === undefined) return null
  const image = config.dockerImage.trim()
  if (image === '') throw new Error('dockerImage must not be empty when Docker execution is enabled')
  return { image, network: config.dockerNetwork }
}

export function createDockerPathMapper(options: {
  workspaceRoot: string
  workdir: string
  junitJar?: string
}): DockerPathMapper {
  return {
    workspaceRoot: resolve(options.workspaceRoot),
    workdir: resolve(options.workdir),
    junitJar: options.junitJar === undefined ? undefined : resolve(options.junitJar),
    extras: new Map(),
    next: 0,
  }
}

export function toContainerPath(mapper: DockerPathMapper, hostPath: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(hostPath)) {
    throw new Error(
      `Docker execution does not support URL classpath entries (${hostPath}); download the jar into the workspace first.`,
    )
  }
  if (hostPath.includes('*')) {
    throw new Error(
      `Docker execution does not support wildcard classpath entries (${hostPath}); list the jars explicitly.`,
    )
  }

  const path = resolve(hostPath)
  if (mapper.junitJar !== undefined && samePath(path, mapper.junitJar)) {
    return CONTAINER_JUNIT
  }
  const workRelative = relativeTo(mapper.workdir, path)
  if (workRelative !== null) return joinContainer(CONTAINER_WORKDIR, workRelative)
  const workspaceRelative = relativeTo(mapper.workspaceRoot, path)
  if (workspaceRelative !== null) return joinContainer(CONTAINER_WORKSPACE, workspaceRelative)

  const key = process.platform === 'win32' ? path.toLowerCase() : path
  const existing = mapper.extras.get(key)
  if (existing !== undefined) return existing.target
  mapper.next += 1
  const target = `/dsh-libs/cp-${mapper.next}`
  mapper.extras.set(key, { host: path, target })
  return target
}

export async function runDocker(options: DockerRunOptions): Promise<DockerRunResult> {
  const subprocess = options.ctx.get('subprocess')
  if (!subprocess) {
    throw new Error('dsh-java-runner requires the subprocess service (ctx.subprocess)')
  }
  let binary: string
  try {
    binary = await subprocess.resolveExecutable('docker')
  } catch {
    throw new Error(
      'Docker execution was requested (dockerImage is set), but the docker executable was not found on PATH. Install Docker or unset dockerImage.',
    )
  }

  const container = containerName(String(options.exec.callId))
  const mounts = mountArguments(options.mapper, options.policy)
  const argv = [
    binary,
    'run',
    '--rm',
    '--init',
    '--name',
    container,
    '--network',
    options.configuration.network,
    '--stop-timeout',
    '2',
    ...mounts,
    '-w',
    CONTAINER_WORKSPACE,
    ...(options.stdin === undefined ? [] : ['-i']),
    options.configuration.image,
    ...options.argv,
  ]

  const result = await runProcess(options.ctx, {
    argv,
    cwd: options.mapper.workspaceRoot,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
    signal: options.exec.signal,
    spillDir: options.mapper.workdir,
    policy: options.policy,
    stdoutMaxBytes: options.stdoutMaxBytes,
    stderrMaxBytes: options.stderrMaxBytes,
  })
  if (result.timedOut || result.aborted) {
    await forceRemoveContainer(subprocess, binary, container, options.mapper.workdir)
  }

  return {
    ...result,
    docker: {
      image: options.configuration.image,
      network: options.configuration.network,
      container,
    },
  }
}

function mountArguments(
  mapper: DockerPathMapper,
  policy: SandboxExecutionPolicy,
): string[] {
  const workspaceMode = policy.mode === 'read-only' ? 'ro' : 'rw'
  const args = [
    '-v',
    `${mapper.workspaceRoot}:${CONTAINER_WORKSPACE}:${workspaceMode}`,
    '-v',
    `${mapper.workdir}:${CONTAINER_WORKDIR}:rw`,
  ]
  if (mapper.junitJar !== undefined) {
    args.push('-v', `${mapper.junitJar}:${CONTAINER_JUNIT}:ro`)
  }
  for (const { host, target } of [...mapper.extras.values()].sort((left, right) =>
    left.target.localeCompare(right.target),
  )) {
    args.push('-v', `${host}:${target}:ro`)
  }
  return args
}

async function forceRemoveContainer(
  subprocess: SubprocessRuntime,
  binary: string,
  container: string,
  cwd: string,
): Promise<void> {
  try {
    const handle = subprocess.spawn({
      argv: [binary, 'rm', '--force', container],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 1000,
    })
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000)
      timer.unref?.()
    })
    await Promise.race([handle.done.catch(() => {}), timeout])
  } catch {
    // The container may already be gone; cleanup is best effort.
  }
}

function containerName(callId: string): string {
  const safe = callId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40)
  return `dsh-java-${process.pid}-${safe === '' ? 'call' : safe}`
}

function relativeTo(root: string, path: string): string | null {
  const rel = relative(root, path)
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

function joinContainer(base: string, relativePath: string): string {
  if (relativePath === '') return base
  return `${base}/${relativePath.split(sep).join('/')}`
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}
