import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CliError } from './errors.js'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function readJson<T>(file: string, fallback: T, validate: (value: unknown) => value is T): Promise<T> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CliError(`Malformed JSON in ${file}`, 2)
  }
  if (!validate(value)) throw new CliError(`Invalid data in ${file}`, 2)
  return value
}

export async function writeJsonAtomic<T>(file: string, value: T): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, file)
}

export async function readLines(file: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter((line) => line.length > 0)
}

export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(path.dirname(file))
  await writeFile(file, `${line}\n`, { flag: 'a' })
}

export async function rewriteLines(file: string, lines: string[]): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, lines.length ? `${lines.join('\n')}\n` : '')
  await rename(temp, file)
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}
