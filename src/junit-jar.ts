import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import type { Config } from './config.js'

export const JUNIT_VERSION = '1.13.4'
export const JUNIT_SHA256 = '3fdfc37e29744a9a67dd5365e81467e26fbde0b7aa204e6f8bbe79eeaa7ae892'

const JUNIT_FILENAME = `junit-platform-console-standalone-${JUNIT_VERSION}.jar`
const JUNIT_URL = `https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/${JUNIT_VERSION}/${JUNIT_FILENAME}`

export type JunitJarSource = 'config' | 'm2' | 'cache' | 'download'

export interface JunitJar {
  path: string
  version: string | null
  source: JunitJarSource
}

const inflight = new Map<string, Promise<JunitJar>>()

export async function resolveJunitJar(
  config: Pick<Config, 'junitJarPath'>,
  signal: AbortSignal,
): Promise<JunitJar> {
  if (config.junitJarPath !== undefined) {
    const path = resolve(config.junitJarPath)
    if (!(await isFile(path))) {
      throw new Error(`junitJarPath does not point to a readable file: ${path}`)
    }
    return { path, version: versionFromName(path), source: 'config' }
  }

  const fromMaven = await findInMavenRepository()
  if (fromMaven !== null) return fromMaven

  const cachePath = cacheJarPath()
  const cached = await verifyCachedJar(cachePath)
  if (cached) return { path: cachePath, version: JUNIT_VERSION, source: 'cache' }

  const pending = inflight.get(cachePath)
  if (pending !== undefined) return pending

  const download = downloadJar(cachePath, signal).finally(() => {
    inflight.delete(cachePath)
  })
  inflight.set(cachePath, download)
  return download
}

function cacheJarPath(): string {
  return join(homedir(), '.dsh-java-runner', 'junit', JUNIT_FILENAME)
}

async function findInMavenRepository(): Promise<JunitJar | null> {
  const root = join(
    homedir(),
    '.m2',
    'repository',
    'org',
    'junit',
    'platform',
    'junit-platform-console-standalone',
  )
  const pinned = join(root, JUNIT_VERSION, JUNIT_FILENAME)
  if (await isFile(pinned)) {
    return { path: pinned, version: JUNIT_VERSION, source: 'm2' }
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersions)
    .reverse()

  for (const version of versions) {
    const path = join(root, version, `junit-platform-console-standalone-${version}.jar`)
    if (await isFile(path)) {
      return { path, version, source: 'm2' }
    }
  }
  return null
}

async function verifyCachedJar(path: string): Promise<boolean> {
  let content: Buffer
  try {
    content = await readFile(path)
  } catch {
    return false
  }
  const actual = createHash('sha256').update(content).digest('hex')
  if (actual === JUNIT_SHA256) return true
  await rm(path, { force: true }).catch(() => {})
  return false
}

async function downloadJar(cachePath: string, signal: AbortSignal): Promise<JunitJar> {
  const response = await fetch(JUNIT_URL, { signal }).catch((error: unknown) => {
    throw new Error(
      `Failed to download the JUnit console jar from ${JUNIT_URL}: ${messageOf(error)}. Set the "junitJarPath" config to a local junit-platform-console-standalone jar to work offline.`,
    )
  })
  if (!response.ok) {
    throw new Error(
      `Failed to download the JUnit console jar from ${JUNIT_URL}: HTTP ${response.status}. Set the "junitJarPath" config to a local jar to work offline.`,
    )
  }

  const content = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(content).digest('hex')
  if (actual !== JUNIT_SHA256) {
    throw new Error(
      `Downloaded JUnit console jar failed SHA-256 verification (expected ${JUNIT_SHA256}, got ${actual}); refusing to use it.`,
    )
  }

  await mkdir(dirname(cachePath), { recursive: true })
  const temporary = `${cachePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content)
  await rename(temporary, cachePath)
  return { path: cachePath, version: JUNIT_VERSION, source: 'download' }
}

function versionFromName(path: string): string | null {
  return /junit-platform-console-standalone-(.+)\.jar$/i.exec(path)?.[1] ?? null
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/)
  const right = b.split(/[.-]/)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index]
    const r = right[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number(l)
    const rn = Number(r)
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln - rn
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }
  return 0
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
