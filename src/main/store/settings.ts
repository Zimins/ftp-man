import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings } from '@shared/types'

export const DEFAULT_SETTINGS: Settings = {
  mcpEnabled: true,
  mcpPort: 7391,
  approvalMode: 'deletes',
  readOnly: false,
  maxTextBytes: 1_000_000,
  idleTimeoutSec: 90,
  maxConnections: 6,
  language: 'system'
}

export class SettingsStore {
  private value: Settings = { ...DEFAULT_SETTINGS }
  private listeners = new Set<(s: Settings) => void>()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<Settings>
      this.value = { ...DEFAULT_SETTINGS, ...raw }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // Write defaults so the stdio bridge can always discover the port.
      await this.set({})
    }
  }

  get(): Settings {
    return { ...this.value }
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    const next: Settings = { ...this.value, ...patch }
    if (!Number.isInteger(next.mcpPort) || next.mcpPort < 1024 || next.mcpPort > 65535) {
      throw new Error('mcpPort must be between 1024 and 65535')
    }
    if (!['none', 'deletes', 'writes', 'all'].includes(next.approvalMode)) throw new Error('invalid approvalMode')
    if (!Number.isFinite(next.maxTextBytes) || next.maxTextBytes < 1024) throw new Error('maxTextBytes too small')
    if (!Number.isFinite(next.idleTimeoutSec) || next.idleTimeoutSec < 5) throw new Error('idleTimeoutSec too small')
    if (!Number.isInteger(next.maxConnections) || next.maxConnections < 1 || next.maxConnections > 50) throw new Error('maxConnections must be 1-50')
    if (!['system', 'ko', 'en'].includes(next.language)) throw new Error('invalid language')
    this.value = next
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.value, null, 2), { mode: 0o600 })
    for (const l of this.listeners) l(this.get())
    return this.get()
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
