import { realpath } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findTestReportFiles } from '../src/project.js'
import type { Harness } from './helpers/harness.js'
import { createHarness } from './helpers/harness.js'

interface ProjectTestValue {
  success: boolean
  timedOut: boolean
  exitCode: number | null
  signal: string | null
  system: 'maven' | 'gradle'
  command: string
  projectDir: string
  wrapper: boolean
  jdkHome: string
  total: number
  passed: number
  failed: number
  skipped: number
  failures: { test: string; message: string; stackTrace: string }[]
  reportFiles: number
  workdir: string | null
  retained: boolean
  retainedReason: string | null
  sandbox: { mode: string; enforcement: string } | null
  stdout: string
  stderr: string
}

const FAILING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.FooTest" tests="2" skipped="0" failures="1" errors="0">
  <testcase name="ok()" classname="com.example.FooTest"/>
  <testcase name="bad()" classname="com.example.FooTest">
    <failure message="expected: &lt;1&gt; but was: &lt;2&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <1> but was: <2>
	at com.example.FooTest.bad(FooTest.java:12)]]></failure>
  </testcase>
</testsuite>
`

const PASSING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.FooTest" tests="1" skipped="0" failures="0" errors="0">
  <testcase name="ok()" classname="com.example.FooTest"/>
</testsuite>
`

let harness: Harness | undefined

afterEach(async () => {
  if (harness) {
    await harness.dispose()
    harness = undefined
  }
})

async function project(files: Record<string, string>): Promise<string> {
  if (harness === undefined) throw new Error('harness is not initialized')
  for (const [name, content] of Object.entries(files)) {
    const path = join(harness.workspace, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  return harness.workspace
}

async function execute<T>(args: unknown): Promise<T> {
  if (harness === undefined) throw new Error('harness is not initialized')
  const result = await harness.execute('java_project_test', args)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('java_project_test returned a tool error')
  return result.value as unknown as T
}

async function writeReport(
  cwd: string | undefined,
  relativePath: string,
  xml: string,
): Promise<void> {
  const path = join(cwd ?? '.', relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, xml)
}

function busyHandler(relativePath: string, xml: string, exitCode: number) {
  return async (call: Parameters<NonNullable<Harness['fake']['handler']>>[0]) => {
    if (call.probe) return undefined
    await writeReport(call.spec.cwd, relativePath, xml)
    return { exitCode }
  }
}

describe('java_project_test', () => {
  it('registers alongside the other Java tools', async () => {
    harness = await createHarness()
    expect(harness.ctx.tools.get('java_project_test')?.name).toBe('java_project_test')
  })

  it('detects Maven, runs mvn test, and parses surefire failures', async () => {
    harness = await createHarness()
    const root = await project({ 'demo/pom.xml': '<project/>' })
    harness.fake.handler = busyHandler(
      'target/surefire-reports/TEST-com.example.FooTest.xml',
      FAILING_XML,
      1,
    )

    const value = await execute<ProjectTestValue>({ directory: 'demo' })

    expect(value.system).toBe('maven')
    expect(value.command).toBe('mvn test')
    expect(value.wrapper).toBe(false)
    expect(value.projectDir).toBe(await realpath(join(root, 'demo')))
    expect(value.jdkHome).toBe(harness.fake.home)
    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(1)
    expect(value.total).toBe(2)
    expect(value.passed).toBe(1)
    expect(value.failed).toBe(1)
    expect(value.reportFiles).toBe(1)
    expect(value.failures[0]).toMatchObject({
      test: 'com.example.FooTest#bad()',
      message: 'expected: <1> but was: <2>',
    })
    expect(value.failures[0]?.stackTrace).toContain('FooTest.java:12')
    expect(value.retained).toBe(true)
    expect(value.retainedReason).toBe('the call did not succeed')
    expect(value.workdir).not.toBeNull()

    const call = harness.fake.callsOf('mvn')[0]
    expect(call?.spec.cwd).toBe(await realpath(join(root, 'demo')))
    expect(call?.spec.argv.slice(1)).toEqual([
      '-B',
      '-q',
      '-ntp',
      '-Dstyle.color=never',
      'test',
    ])
    expect(call?.spec.env?.['JAVA_HOME']).toBe(harness.fake.home)
    expect(call?.spec.env?.['MAVEN_OPTS']).toContain('-Duser.language=en')
  })

  it('detects Gradle and cleans up when every test passes', async () => {
    harness = await createHarness()
    await project({ 'demo/build.gradle': 'plugins {}' })
    harness.fake.handler = busyHandler(
      'build/test-results/test/TEST-com.example.FooTest.xml',
      PASSING_XML,
      0,
    )

    const value = await execute<ProjectTestValue>({ directory: 'demo' })

    expect(value.system).toBe('gradle')
    expect(value.command).toBe('gradle test')
    expect(value.success).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.total).toBe(1)
    expect(value.passed).toBe(1)
    expect(value.failed).toBe(0)
    expect(value.retained).toBe(false)
    expect(value.workdir).toBeNull()

    const call = harness.fake.callsOf('gradle')[0]
    expect(call?.spec.argv.slice(1)).toEqual(['--console=plain', '--no-daemon', 'test'])
    expect(call?.spec.env?.['GRADLE_OPTS']).toContain('-Dfile.encoding=UTF-8')
  })

  it('passes offline flags to the build tool', async () => {
    harness = await createHarness()
    await project({
      'maven/pom.xml': '<project/>',
      'gradle/build.gradle.kts': 'plugins {}',
    })
    harness.fake.handler = busyHandler('build/test-results/test/TEST-A.xml', PASSING_XML, 0)

    await execute<ProjectTestValue>({ directory: 'maven', offline: true })
    await execute<ProjectTestValue>({ directory: 'gradle', offline: true })

    const maven = harness.fake.callsOf('mvn')[0]
    expect(maven?.spec.argv).toContain('-o')
    const gradle = harness.fake.callsOf('gradle')[0]
    expect(gradle?.spec.argv).toContain('--offline')
  })

  it('fails when the build succeeds but no reports are parsed', async () => {
    harness = await createHarness()
    await project({ 'pom.xml': '<project/>' })

    const value = await execute<ProjectTestValue>({})

    expect(value.success).toBe(false)
    expect(value.exitCode).toBe(0)
    expect(value.total).toBe(0)
    expect(value.retained).toBe(true)
  })

  it('requires an explicit system when both build files exist', async () => {
    harness = await createHarness()
    await project({ 'pom.xml': '<project/>', 'build.gradle': 'plugins {}' })

    const auto = await harness.execute('java_project_test', {})
    expect(auto.isError).toBe(true)

    harness.fake.handler = busyHandler('target/surefire-reports/TEST-A.xml', PASSING_XML, 0)
    const maven = await execute<ProjectTestValue>({ system: 'maven' })
    expect(maven.system).toBe('maven')
  })

  it('reports guidance when no build file is found', async () => {
    harness = await createHarness()
    await project({ 'README.md': 'nothing here' })

    const result = await harness.execute('java_project_test', {})
    expect(result.isError).toBe(true)
  })

  it('keeps the scratch directory on request', async () => {
    harness = await createHarness()
    await project({ 'pom.xml': '<project/>' })
    harness.fake.handler = busyHandler('target/surefire-reports/TEST-A.xml', PASSING_XML, 0)

    const value = await execute<ProjectTestValue>({ keepWorkdir: true })

    expect(value.success).toBe(true)
    expect(value.retained).toBe(true)
    expect(value.retainedReason).toBe('keepWorkdir was set')
    expect(value.workdir).not.toBeNull()
  })

  it('prefers the project wrapper over PATH', async () => {
    harness = await createHarness()
    const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'
    await project({ 'pom.xml': '<project/>', [wrapper]: '@echo off\n' })
    harness.fake.handler = busyHandler('target/surefire-reports/TEST-A.xml', PASSING_XML, 0)

    const value = await execute<ProjectTestValue>({})

    expect(value.success).toBe(true)
    expect(value.wrapper).toBe(true)
    const call = harness.fake.calls.find((entry) => !entry.probe && entry.kind !== 'javac')
    expect(call?.kind).not.toBe('mvn')
    const argv = call?.spec.argv ?? []
    if (process.platform === 'win32') {
      expect(argv[0]?.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(argv[1]).toBe('/d')
      expect(argv[2]).toBe('/s')
      expect(argv[3]).toBe('/c')
      expect(argv[4]).toContain(wrapper)
      expect(argv[4]).toContain('test')
    } else {
      expect(argv.some((arg) => arg.endsWith(wrapper))).toBe(true)
    }
  })

  it('confines the build under a workspace-write policy', async () => {
    harness = await createHarness({ mode: 'workspace-write' })
    await project({ 'pom.xml': '<project/>' })
    harness.fake.handler = busyHandler('target/surefire-reports/TEST-A.xml', PASSING_XML, 0)

    const value = await execute<ProjectTestValue>({})

    expect(value.success).toBe(true)
    expect(value.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'partial' })
    expect(harness.sandboxCalls).toHaveLength(1)
  })

  it('scans surefire and Gradle report directories only', async () => {
    harness = await createHarness()
    const root = await project({
      'module-a/target/surefire-reports/TEST-a.xml': PASSING_XML,
      'build/test-results/test/TEST-g.xml': PASSING_XML,
      'stray/TEST-c.xml': PASSING_XML,
      'node_modules/pkg/surefire-reports/TEST-n.xml': PASSING_XML,
      '.git/surefire-reports/TEST-git.xml': PASSING_XML,
    })

    const files = await findTestReportFiles(root)

    expect(files).toHaveLength(2)
    expect(files.some((file) => file.endsWith(join('module-a', 'target', 'surefire-reports', 'TEST-a.xml')))).toBe(true)
    expect(files.some((file) => file.endsWith(join('build', 'test-results', 'test', 'TEST-g.xml')))).toBe(true)
  })
})
