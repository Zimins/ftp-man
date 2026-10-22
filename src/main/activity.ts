import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ActivityEntry } from '@shared/types'

/** In-memory ring buffer of recent agent actions, mirrored to a JSONL file for auditing. */
export class ActivityLog {
  private entries: ActivityEntry[] = []
  private listeners = new Set<(entry: ActivityEntry) => void>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly max = 500
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const lines = raw.split('\n').filter(Boolean).slice(-this.max)
      this.entries = lines
        .map((l) => {
          try {
            return JSON.parse(l) as ActivityEntry
          } catch {
            return null
          }
        })
        .filter((e): e is ActivityEntry => !!e)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  add(input: Omit<ActivityEntry, 'id' | 'ts'>): ActivityEntry {
    const entry: ActivityEntry = { id: randomUUID(), ts: new Date().toISOString(), ...input }
    this.entries.push(entry)
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(dirname(this.filePath), { recursive: true })
        await fs.appendFile(this.filePath, JSON.stringify(entry) + '\n', { mode: 0o600 })
      })
      .catch(() => undefined)
    for (const l of this.listeners) l(entry)
    return entry
  }

  list(): ActivityEntry[] {
    return [...this.entries].reverse()
  }

  async clear(): Promise<void> {
    this.entries = []
    await fs.writeFile(this.filePath, '', { mode: 0o600 }).catch(() => undefined)
  }

  onAdd(listener: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
