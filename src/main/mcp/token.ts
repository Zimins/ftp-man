import { promises as fs, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * The bearer token lives in a 0600 file so the stdio bridge (a separate process that
 * cannot use safeStorage) can read it. It only grants access to the local MCP endpoint,
 * never to the stored credentials directly.
 */
export class TokenFile {
  private cached: string | null = null

  constructor(readonly path: string) {}

  async ensure(): Promise<string> {
    try {
      const t = (await fs.readFile(this.path, 'utf8')).trim()
      if (t.length >= 32) {
        this.cached = t
        return t
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return this.regenerate()
  }

  async regenerate(): Promise<string> {
    const t = randomBytes(32).toString('hex')
    await fs.mkdir(dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, t + '\n', { mode: 0o600 })
    await fs.chmod(this.path, 0o600)
    this.cached = t
    return t
  }

  get(): string {
    if (this.cached) return this.cached
    this.cached = readFileSync(this.path, 'utf8').trim()
    return this.cached
  }
}
