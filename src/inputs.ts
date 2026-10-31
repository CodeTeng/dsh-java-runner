import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

export interface SourceFileRequest {
  path: string
  content?: string
}

export interface MaterializedFile {
  /** Normalized workspace-relative path using forward slashes. */
  path: string
  absolutePath: string
  source: 'inline' | 'workspace'
  sourceAbsolutePath: string | null
}

export interface ScratchDirectory {
  workdir: string
  outDir: string
}

export async function createScratch(
  workspaceRoot: string,
  scratchRoot: string | undefined,
  callId: string,
): Promise<ScratchDirectory> {
  const root = resolve(scratchRoot ?? join(workspaceRoot, '.dsh-java'))
  await mkdir(root, { recursive: true })
  const prefix = `${sanitizeSegment(callId)}-`
  const workdir = await mkdtemp(join(root, prefix))
  const outDir = join(workdir, 'classes')
  await mkdir(outDir, { recursive: true })
  return { workdir, outDir }
}

export async function removeScratch(workdir: string): Promise<void> {
  await rm(workdir, { recursive: true, force: true })
}

export async function materializeFiles(
  workspaceRoot: string,
  workdir: string,
  files: readonly SourceFileRequest[],
): Promise<MaterializedFile[]> {
  const root = await realpath(resolve(workspaceRoot))
  const materialized: MaterializedFile[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const path = normalizeRelativePath(file.path)
    if (seen.has(path)) {
      throw new Error(`Duplicate source path "${path}"`)
    }
    seen.add(path)

    const target = join(workdir, path)
    assertInside(workdir, target)

    let sourceAbsolutePath: string | null = null
    let content: string
    if (file.content !== undefined) {
      content = file.content
    } else {
      const source = await resolveWorkspaceFile(root, path)
      sourceAbsolutePath = source
      content = await readFile(source, 'utf8')
    }

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    materialized.push({
      path,
      absolutePath: target,
      source: file.content === undefined ? 'workspace' : 'inline',
      sourceAbsolutePath,
    })
  }

  return materialized
}

export function normalizeRelativePath(input: string): string {
  const raw = input.replace(/\\/g, '/').trim()
  if (raw === '') throw new Error('Source path must not be empty')
  if (raw.includes('\0')) throw new Error('Source path must not contain NUL bytes')
  if (posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Source path "${input}" must be workspace-relative, not absolute`)
  }

  const normalized = posix.normalize(raw)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error(`Source path "${input}" escapes the workspace`)
  }
  return normalized
}

async function resolveWorkspaceFile(root: string, path: string): Promise<string> {
  const candidate = resolve(root, path)
  assertInside(root, candidate)

  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    throw new Error(`Source file "${path}" was not found in the workspace`)
  }
  assertInside(root, real)

  const info = await stat(real)
  if (!info.isFile()) {
    throw new Error(`Source path "${path}" is not a regular file`)
  }
  return real
}

export function assertInside(root: string, child: string): void {
  const rel = relative(root, child)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${child}" escapes the workspace`)
  }
}

export function displayPath(absolutePath: string, workdir: string): string {
  const rel = relative(workdir, absolutePath)
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel.split(sep).join('/')
  }
  return absolutePath
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return cleaned === '' ? 'call' : cleaned
}
