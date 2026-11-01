import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Harness } from './helpers/harness.js'
import { createHarness } from './helpers/harness.js'

interface DockerFacts {
  image: string
  network: string
  container: string
}

interface DockerValue {
  success: boolean
  timedOut: boolean
  stdout: string
  docker: DockerFacts | null
  compile?: { success: boolean } | null
  total?: number
  passed?: number
  jshell?: string
}

const IMAGE = 'eclipse-temurin:17-jdk'
const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="FakeTest" tests="1" skipped="0" failures="0" errors="0">
  <testcase name="ok()" classname="FakeTest"/>
</testsuite>
`

let harness: Harness | undefined

afterEach(async () => {
  if (harness) {
    await harness.dispose()
    harness = undefined
  }
})

async function execute(name: string, args: unknown): Promise<DockerValue> {
  if (harness === undefined) throw new Error('harness is not initialized')
  const result = await harness.execute(name, args)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(`${name} returned a tool error`)
  return result.value as unknown as DockerValue
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}

function hostVolume(argv: readonly string[], target: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '-v') continue
    const value = argv[index + 1] ?? ''
    const match = new RegExp(`^(.*):${target}:(rw|ro)$`).exec(value)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

function containerArgs(argv: readonly string[], image: string): string[] {
  const index = argv.indexOf(image)
  if (index < 0) throw new Error(`image ${image} is missing from docker argv`)
  return argv.slice(index + 1)
}

describe('docker execution backend', () => {
  it('runs compiled code in a no-network container with mapped mounts', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })
    harness.fake.handler = (call) =>
      call.kind === 'docker' ? { stdout: 'container-out\n', exitCode: 0 } : undefined

    const value = await execute('java_run', {
      main: 'Main',
      files: [{ path: 'Main.java', content: 'public class Main {}' }],
    })

    expect(value.success).toBe(true)
    expect(value.stdout).toBe('container-out\n')
    expect(value.docker?.image).toBe(IMAGE)
    expect(value.docker?.network).toBe('none')
    expect(value.docker?.container).toMatch(/^dsh-java-/)

    const call = harness.fake.callsOf('docker')[0]
    const argv = call?.spec.argv ?? []
    expect(argv[1]).toBe('run')
    expect(argv).toContain('--rm')
    expect(flagValue(argv, '--network')).toBe('none')
    expect(flagValue(argv, '--name')).toBe(value.docker?.container)
    expect(argv).toContain(`${harness.workspace}:/workspace:rw`)
    expect(hostVolume(argv, '/dsh-work')).toBeDefined()
    expect(call?.spec.env?.['JAVA_HOME']).toBeUndefined()

    const inner = containerArgs(argv, IMAGE)
    expect(inner[0]).toBe('java')
    expect(flagValue(inner, '-cp')).toContain('/dsh-work/classes')
    expect(inner.join(' ')).not.toContain(harness.workspace)
    expect(inner).toContain('Main')
  })

  it('runs JUnit inside the container and parses reports from the mounted scratch', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })
    harness.fake.handler = async (call) => {
      if (call.kind === 'docker') {
        const workdir = hostVolume(call.spec.argv, '/dsh-work')
        if (workdir === undefined) return { exitCode: 9 }
        await mkdir(join(workdir, 'reports'), { recursive: true })
        await writeFile(join(workdir, 'reports', 'TEST-FakeTest.xml'), PASSING_XML)
        return { exitCode: 0 }
      }
      return undefined
    }

    const value = await execute('java_test', {
      files: [{ path: 'FakeTest.java', content: 'public class FakeTest {}' }],
    })

    expect(value.success).toBe(true)
    expect(value.total).toBe(1)
    expect(value.passed).toBe(1)
    expect(value.docker?.image).toBe(IMAGE)

    const argv = harness.fake.callsOf('docker')[0]?.spec.argv ?? []
    expect(argv).toContain(`${harness.fake.jarPath}:/dsh-libs/junit.jar:ro`)
    const inner = containerArgs(argv, IMAGE)
    expect(inner[0]).toBe('java')
    expect(inner).toContain('/dsh-libs/junit.jar')
    expect(flagValue(inner, '--reports-dir')).toBe('/dsh-work/reports')
    expect(flagValue(inner, '--class-path')).toContain('/dsh-work/classes')
  })

  it('evaluates snippets without requiring a host JDK', async () => {
    harness = await createHarness({
      config: {
        dockerImage: IMAGE,
        dockerNetwork: 'none',
        javaHome: join(process.cwd(), 'definitely-missing-jdk'),
      },
    })
    harness.fake.handler = (call) =>
      call.kind === 'docker' ? { stdout: 'hi\r\njshell> ', exitCode: 0 } : undefined

    const value = await execute('java_eval', { code: 'System.out.println("hi");' })

    expect(value.success).toBe(true)
    expect(value.stdout).toBe('hi')
    expect(value.jshell).toBe('jshell')
    expect(value.docker?.image).toBe(IMAGE)
    expect(harness.fake.calls.every((call) => call.kind === 'docker')).toBe(true)

    const inner = containerArgs(harness.fake.callsOf('docker')[0]?.spec.argv ?? [], IMAGE)
    expect(inner[0]).toBe('jshell')
    expect(inner).toContain('/dsh-work/snippet.jsh')
    expect(inner).toContain('-R-Duser.language=en')
  })

  it('mounts the workspace read-only under a read-only policy', async () => {
    harness = await createHarness({
      mode: 'read-only',
      config: { dockerImage: IMAGE, dockerNetwork: 'none' },
    })

    const value = await execute('java_run', { main: 'Main' })

    expect(value.success).toBe(true)
    const argv = harness.fake.callsOf('docker')[0]?.spec.argv ?? []
    expect(argv).toContain(`${harness.workspace}:/workspace:ro`)
  })

  it('honors a bridge network when configured', async () => {
    harness = await createHarness({
      config: { dockerImage: IMAGE, dockerNetwork: 'bridge' },
    })

    const value = await execute('java_run', { main: 'Main' })

    expect(value.docker?.network).toBe('bridge')
    const argv = harness.fake.callsOf('docker')[0]?.spec.argv ?? []
    expect(flagValue(argv, '--network')).toBe('bridge')
  })

  it('mounts external classpath entries read-only', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })
    const jar = join(harness.fake.home, 'extra.jar')
    await writeFile(jar, '')

    await execute('java_run', { main: 'Main', classpath: [jar] })

    const argv = harness.fake.callsOf('docker')[0]?.spec.argv ?? []
    expect(argv).toContain(`${jar}:/dsh-libs/cp-1:ro`)
    const inner = containerArgs(argv, IMAGE)
    expect(flagValue(inner, '-cp')).toBe('/dsh-libs/cp-1')
  })

  it('joins container classpath entries with the Linux separator', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })
    const first = join(harness.fake.home, 'first.jar')
    const second = join(harness.fake.home, 'second.jar')
    await writeFile(first, '')
    await writeFile(second, '')

    await execute('java_run', { main: 'Main', classpath: [first, second] })

    const argv = harness.fake.callsOf('docker')[0]?.spec.argv ?? []
    const inner = containerArgs(argv, IMAGE)
    expect(flagValue(inner, '-cp')).toBe('/dsh-libs/cp-1:/dsh-libs/cp-2')
  })

  it('rejects URL classpath entries in Docker mode', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })

    const result = await harness.execute('java_run', {
      main: 'Main',
      classpath: ['https://example.com/x.jar'],
    })

    expect(result.isError).toBe(true)
  })

  it('reports guidance when docker is not installed', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })
    await rm(join(harness.fake.home, 'bin', process.platform === 'win32' ? 'docker.exe' : 'docker'))

    const result = await harness.execute('java_run', { main: 'Main' })

    expect(result.isError).toBe(true)
  })

  it('force-removes the container after a timeout', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })
    harness.fake.handler = (call) =>
      call.kind === 'docker'
        ? call.spec.argv.includes('rm')
          ? { exitCode: 0 }
          : { exitCode: 0, delayMs: 5000 }
        : undefined

    const value = await execute('java_run', { main: 'Main', timeoutMs: 100 })

    expect(value.success).toBe(false)
    expect(value.timedOut).toBe(true)
    const calls = harness.fake.callsOf('docker')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.spec.argv).toContain('rm')
    expect(calls[1]?.spec.argv).toContain('--force')
    expect(calls[1]?.spec.argv).toContain(value.docker?.container)
  })

  it('does not start Docker when compilation fails', async () => {
    harness = await createHarness({ config: { dockerImage: IMAGE, dockerNetwork: 'none' } })
    harness.fake.handler = (call) =>
      call.kind === 'javac' && !call.probe
        ? { stderr: 'Broken.java:1:1: compiler.err.expected: token.identifier\n', exitCode: 1 }
        : undefined

    const value = await execute('java_run', {
      main: 'Main',
      files: [{ path: 'Broken.java', content: 'public class Broken {}' }],
    })

    expect(value.success).toBe(false)
    expect(value.compile?.success).toBe(false)
    expect(value.docker).toBeNull()
    expect(harness.fake.callsOf('docker')).toHaveLength(0)
  })
})
