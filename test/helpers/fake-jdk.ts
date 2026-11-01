import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

export type FakeJdkKind =
  | 'javac'
  | 'java'
  | 'jshell'
  | 'mvn'
  | 'gradle'
  | 'docker'
  | 'cmd'
  | 'sh'
  | 'other'

const FAKE_PROGRAMS = ['javac', 'java', 'jshell', 'mvn', 'gradle', 'docker'] as const

export interface FakeJdkCall {
  kind: FakeJdkKind
  probe: boolean
  spec: SubprocessSpawnSpec
}

export interface FakeJdkResult {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  delayMs?: number
  onStart?: (spec: SubprocessSpawnSpec) => void | Promise<void>
}

export type FakeJdkHandler = (
  call: FakeJdkCall,
) => FakeJdkResult | undefined | Promise<FakeJdkResult | undefined>

export interface FakeJdkOptions {
  javacVersion?: string
  javaVersion?: string
  vendor?: string
}

/**
 * A subprocess service that answers javac/java calls with canned output.
 *
 * Fake executables are not used: the DSH subprocess provider resolves only
 * .exe/.com images on Windows, and portable shell wrappers would not run
 * there. Faking the service keeps the harness deterministic on every OS.
 */
export class FakeJdk {
  readonly calls: FakeJdkCall[] = []
  handler: FakeJdkHandler | undefined

  constructor(
    readonly home: string,
    readonly jarPath: string,
    private readonly options: Required<FakeJdkOptions>,
  ) {}

  readonly service = {
    resolveExecutable: async (command: string): Promise<string> => {
      if ((FAKE_PROGRAMS as readonly string[]).includes(command)) {
        const path = join(this.home, 'bin', executableName(command))
        await access(path)
        return path
      }
      throw new Error(`fake subprocess: ${command} is not on PATH`)
    },
    spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => this.spawn(spec),
  }

  callsOf(kind: FakeJdkKind): FakeJdkCall[] {
    return this.calls.filter((call) => call.kind === kind && !call.probe)
  }

  async dispose(): Promise<void> {
    await rm(this.home, { recursive: true, force: true })
  }

  private spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const kind = kindOf(spec.argv[0])
    const call: FakeJdkCall = { kind, probe: isProbe(kind, spec.argv), spec }
    this.calls.push(call)

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let resolveDone!: (outcome: SubprocessOutcome) => void
    const done = new Promise<SubprocessOutcome>((resolve) => {
      resolveDone = resolve
    })
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolveDone({ exitCode, signal })
    }
    const terminate = (): void => finish(null, 'SIGTERM')

    if (spec.signal?.aborted === true) terminate()
    else spec.signal?.addEventListener('abort', terminate, { once: true })

    void (async () => {
      try {
        const result = await this.resultFor(call)
        stdout = result.stdout ?? ''
        stderr = result.stderr ?? ''
        await result.onStart?.(spec)
        if (settled) return
        const exitCode = result.exitCode === undefined ? 0 : result.exitCode
        const signal = result.signal ?? null
        const delayMs = result.delayMs ?? 0
        if (delayMs > 0) {
          timer = setTimeout(() => finish(exitCode, signal), delayMs)
        } else {
          finish(exitCode, signal)
        }
      } catch (error) {
        stderr = error instanceof Error ? error.message : String(error)
        finish(1, null)
      }
    })()

    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: readerOf(() => stdout),
        stderr: readerOf(() => stderr),
      },
      done,
      terminate,
      waitForExit: async () => {
        await done
        return true
      },
    }
  }

  private async resultFor(call: FakeJdkCall): Promise<FakeJdkResult> {
    const handled = await this.handler?.(call)
    if (handled !== undefined) return handled

    if (call.kind === 'javac') {
      return call.probe ? { stdout: `javac ${this.options.javacVersion}\n` } : { exitCode: 0 }
    }
    if (call.kind === 'java') {
      return call.probe
        ? {
            stderr: [
              `    java.version = ${this.options.javaVersion}`,
              `    java.vendor = ${this.options.vendor}`,
              '',
            ].join('\n'),
          }
        : { stdout: 'fake java\n', exitCode: 0 }
    }
    return { exitCode: 0 }
  }
}

export async function createFakeJdk(options: FakeJdkOptions = {}): Promise<FakeJdk> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-fake-jdk-'))
  const bin = join(home, 'bin')
  await mkdir(bin, { recursive: true })
  for (const program of FAKE_PROGRAMS) {
    await writeFile(join(bin, executableName(program)), '')
  }
  const jarPath = join(home, 'fake-junit.jar')
  await writeFile(jarPath, '')
  return new FakeJdk(home, jarPath, {
    javacVersion: options.javacVersion ?? '17.0.9',
    javaVersion: options.javaVersion ?? '17.0.9',
    vendor: options.vendor ?? 'FakeCorp',
  })
}

function executableName(command: string): string {
  return process.platform === 'win32' ? `${command}.exe` : command
}

function kindOf(program: string | undefined): FakeJdkKind {
  const name = basename(program ?? '')
    .toLowerCase()
    .replace(/\.(?:exe|com|cmd|bat)$/, '')
  if (name.startsWith('javac')) return 'javac'
  if (name === 'java') return 'java'
  if (name === 'jshell') return 'jshell'
  if (name.startsWith('mvn')) return 'mvn'
  if (name.startsWith('gradle')) return 'gradle'
  if (name === 'docker') return 'docker'
  if (name === 'cmd') return 'cmd'
  if (name === 'sh' || name === 'bash') return 'sh'
  return 'other'
}

function isProbe(kind: FakeJdkKind, argv: readonly string[]): boolean {
  if (kind === 'javac') return argv[1] === '-version'
  if (kind === 'java') return argv.includes('-XshowSettings:properties')
  return false
}

function readerOf(text: () => string) {
  return {
    readFrom: (_fromByte: number) => ({
      text: text(),
      nextOffset: text().length,
      lossy: false,
    }),
  }
}
