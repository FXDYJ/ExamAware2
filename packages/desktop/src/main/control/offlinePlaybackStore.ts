import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { OfflineDeployment } from './offlinePlayback'

function filePath() {
  return path.join(app.getPath('userData'), 'control-automation.json')
}

export async function loadOfflineDeployments(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function saveOfflineDeployments(records: OfflineDeployment[]): Promise<void> {
  const target = filePath()
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(temporary, JSON.stringify(records), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}
