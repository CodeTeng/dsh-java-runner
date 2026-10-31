import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { runProcess } from './proc.js'

export type JdkSource = 'config' | 'JAVA_HOME' | 'PATH'

export interface JdkCandidate {
  source: JdkSource
  home: string
  javacPath: string | null
  javaPath: string | null
  version: string | null
  vendor: string | null
  error: string | null
}

export interface JdkDiscovery {
  resolved: JdkCandidate | null
  candidates: JdkCandidate[]
  guidance: string | null
}

const CACHE_MS = 30_000
const PROBE_TIMEOUT_MS = 10_000

export class JdkResolver {
  private cachedAt = 0
  private cached: JdkDiscovery | null = null

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  async discover(options: {
    workspaceRoot: string
    signal: AbortSignal
    refresh?: boolean
  }): Promise<JdkDiscovery> {
    const now = Date.now()
    if (
      options.refresh !== true &&
      this.cached !== null &&
      now - this.cachedAt < CACHE_MS
    ) {
      return this.cached
    }

    const discovery = await this.scan(options.workspaceRoot, options.signal)
    this.cached = discovery
    this.cachedAt = now
    return discovery
  }

  async require(options: {
    workspaceRoot: string
    signal: AbortSignal
  }): Promise<JdkCandidate> {
    const discovery = await this.discover(options)
    if (discovery.resolved === null) {
      throw new Error(discovery.guidance ?? 'No JDK with javac was found')
    }
    return discovery.resolved
  }

  private async scan(workspaceRoot: string, signal: AbortSignal): Promise<JdkDiscovery> {
    const raw = await this.candidates()
    const seen = new Set<string>()
    const candidates: JdkCandidate[] = []

    for (const candidate of raw) {
      const key = (candidate.home || candidate.javacPath || '').toLowerCase()
      if (key !== '' && seen.has(key)) continue
      if (key !== '') seen.add(key)
      candidates.push(
        await this.probe(candidate, workspaceRoot, signal),
      )
    }

    const resolved = candidates.find((candidate) => candidate.error === null) ?? null
    return {
      resolved,
      candidates,
      guidance: resolved === null ? guidanceFor(candidates) : null,
    }
  }

  private async candidates(): Promise<JdkCandidate[]> {
    const result: JdkCandidate[] = []
    const exe = (name: string): string =>
      process.platform === 'win32' ? `${name}.exe` : name

    if (this.config.javacPath !== undefined) {
      const javacPath = resolve(this.config.javacPath)
      result.push({
        source: 'config',
        home: dirname(dirname(javacPath)),
        javacPath,
        javaPath: join(dirname(javacPath), exe('java')),
        version: null,
        vendor: null,
        error: null,
      })
    }

    if (this.config.javaHome !== undefined) {
      const home = resolve(this.config.javaHome)
      result.push({
        source: 'config',
        home,
        javacPath: join(home, 'bin', exe('javac')),
        javaPath: join(home, 'bin', exe('java')),
        version: null,
        vendor: null,
        error: null,
      })
    }

    const javaHome = process.env.JAVA_HOME?.trim()
    if (javaHome) {
      const home = resolve(javaHome)
      result.push({
        source: 'JAVA_HOME',
        home,
        javacPath: join(home, 'bin', exe('javac')),
        javaPath: join(home, 'bin', exe('java')),
        version: null,
        vendor: null,
        error: null,
      })
    }

    const fromPath = await this.pathCandidate(exe)
    if (fromPath !== null) result.push(fromPath)

    return result
  }

  private async pathCandidate(
    exe: (name: string) => string,
  ): Promise<JdkCandidate | null> {
    const subprocess = this.ctx.get('subprocess')
    if (!subprocess) return null

    const lookup = async (name: string): Promise<string | null> => {
      try {
        return await subprocess.resolveExecutable(name)
      } catch {
        return null
      }
    }

    const javac = await lookup('javac')
    const java = await lookup('java')
    if (javac === null && java === null) return null

    const anchor = javac ?? java
    if (anchor === null) return null
    const real = await safeRealpath(anchor)

    return {
      source: 'PATH',
      home: dirname(dirname(real)),
      javacPath: javac === null ? null : await safeRealpath(javac),
      javaPath: java === null ? null : await safeRealpath(java),
      version: null,
      vendor: null,
      error: null,
    }
  }

  private async probe(
    candidate: JdkCandidate,
    workspaceRoot: string,
    signal: AbortSignal,
  ): Promise<JdkCandidate> {
    if (candidate.javacPath === null) {
      return { ...candidate, error: 'javac was not found' }
    }
    if (!(await isFile(candidate.javacPath))) {
      return { ...candidate, error: `javac not found at ${candidate.javacPath}` }
    }
    if (candidate.javaPath === null || !(await isFile(candidate.javaPath))) {
      return {
        ...candidate,
        error: `java not found at ${candidate.javaPath ?? join(candidate.home, 'bin')}`,
      }
    }

    const javacProbe = await runProcess(this.ctx, {
      argv: [candidate.javacPath, '-version'],
      cwd: workspaceRoot,
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      stdoutMaxBytes: 64 * 1024,
      stderrMaxBytes: 64 * 1024,
    })
    const javacOutput = `${javacProbe.stdout}\n${javacProbe.stderr}`
    const version = /javac\s+(\S+)/.exec(javacOutput)?.[1] ?? null
    if (javacProbe.exitCode !== 0 || version === null) {
      return {
        ...candidate,
        version,
        error: `javac -version failed: ${firstLine(javacOutput) || `exit code ${javacProbe.exitCode}`}`,
      }
    }

    const javaProbe = await runProcess(this.ctx, {
      argv: [candidate.javaPath, '-XshowSettings:properties', '-version'],
      cwd: workspaceRoot,
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      stdoutMaxBytes: 128 * 1024,
      stderrMaxBytes: 128 * 1024,
    })
    const javaOutput = `${javaProbe.stdout}\n${javaProbe.stderr}`
    if (javaProbe.exitCode !== 0) {
      return {
        ...candidate,
        version,
        error: `java -version failed: ${firstLine(javaOutput) || `exit code ${javaProbe.exitCode}`}`,
      }
    }

    const reportedVersion =
      /^\s*java\.version\s*=\s*(.+)$/m.exec(javaOutput)?.[1]?.trim() ??
      /version\s+"([^"]+)"/.exec(javaOutput)?.[1] ??
      version
    const vendor =
      /^\s*java\.vendor\s*=\s*(.+)$/m.exec(javaOutput)?.[1]?.trim() ?? null

    return {
      ...candidate,
      version: reportedVersion,
      vendor,
      error: null,
    }
  }
}

function guidanceFor(candidates: JdkCandidate[]): string {
  const details = candidates
    .map((candidate) => `${candidate.source} (${candidate.home}): ${candidate.error}`)
    .join('; ')
  const tried = details === '' ? 'No javac was found on PATH and JAVA_HOME is unset.' : details
  return `No usable JDK found. ${tried} Install JDK 17 or newer, then set JAVA_HOME or the dsh-java-runner "javaHome"/"javacPath" config.`
}

function firstLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
