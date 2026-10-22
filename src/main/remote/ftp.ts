import { Client as FtpLib, type FileInfo } from 'basic-ftp'
import { Readable, Writable } from 'node:stream'
import type { Credentials, RemoteEntry } from '@shared/types'
import {
  RemoteError,
  joinRemote,
  posixBasename,
  posixDirname,
  resolveRemotePath,
  type ConnectableServer,
  type RemoteClient
} from './types'

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/** Unix LIST gives "Sep 11 14:05" for recent files and "Sep 11 2025" for old ones; MLSD gives a real Date. */
function parseModified(f: FileInfo): { modifiedAt?: string; modifiedPrecision?: 'minute' | 'day' } {
  if (f.modifiedAt) return { modifiedAt: f.modifiedAt.toISOString(), modifiedPrecision: 'minute' }
  const raw = (f.rawModifiedAt || '').trim()
  let m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/.exec(raw)
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const d = new Date(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]))
    return { modifiedAt: d.toISOString(), modifiedPrecision: 'day' }
  }
  m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(raw)
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const now = new Date()
    let d = new Date(now.getFullYear(), MONTHS[m[1].toLowerCase()], Number(m[2]), Number(m[3]), Number(m[4]))
    if (d.getTime() > now.getTime() + 24 * 3600 * 1000) d = new Date(now.getFullYear() - 1, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes())
    return { modifiedAt: d.toISOString(), modifiedPrecision: 'minute' }
  }
  const parsed = raw ? new Date(raw) : null
  if (parsed && !Number.isNaN(parsed.getTime())) return { modifiedAt: parsed.toISOString(), modifiedPrecision: 'minute' }
  return { modifiedAt: raw || undefined }
}

function toEntry(dir: string, f: FileInfo): RemoteEntry {
  const type = f.isDirectory ? 'dir' : f.isSymbolicLink ? 'link' : f.isFile ? 'file' : 'other'
  return {
    name: f.name,
    path: joinRemote(dir, f.name),
    type,
    size: f.size,
    ...parseModified(f),
    permissions: f.permissions
      ? [f.permissions.user, f.permissions.group, f.permissions.world].map((n) => n.toString(8)).join('')
      : undefined
  }
}

function wrap(err: unknown): never {
  const e = err as { code?: number; message?: string }
  const msg = e?.message ?? String(err)
  if (e?.code === 550) throw new RemoteError(msg, 'not_found')
  if (e?.code === 530) throw new RemoteError(msg, 'auth')
  throw new RemoteError(msg, 'remote')
}

export class FtpRemoteClient implements RemoteClient {
  readonly baseDir: string

  private constructor(
    private readonly client: FtpLib,
    baseDir: string
  ) {
    this.baseDir = baseDir
  }

  static async connect(server: ConnectableServer, creds: Credentials): Promise<FtpRemoteClient> {
    const client = new FtpLib(30_000)
    try {
      await client.access({
        host: server.host,
        port: server.port,
        user: server.username || 'anonymous',
        password: creds.password ?? (server.username ? '' : 'anonymous@'),
        secure: server.protocol === 'ftps',
        secureOptions: server.protocol === 'ftps' ? { rejectUnauthorized: !server.insecureTls } : undefined
      })
    } catch (err) {
      client.close()
      const e = err as { code?: number; message?: string }
      if (e?.code === 530) throw new RemoteError(`Login failed: ${e.message}`, 'auth')
      throw new RemoteError(`Connect failed: ${e?.message ?? String(err)}`, 'connect')
    }
    let home = '/'
    try {
      home = await client.pwd()
    } catch {
      /* some servers reject PWD; assume root */
    }
    const base = server.rootPath ? resolveRemotePath(home, server.rootPath) : home
    return new FtpRemoteClient(client, base)
  }

  private abs(p: string): string {
    return resolveRemotePath(this.baseDir, p)
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const dir = this.abs(path)
    try {
      const items = await this.client.list(dir)
      return items.filter((f) => f.name !== '.' && f.name !== '..').map((f) => toEntry(dir, f))
    } catch (err) {
      wrap(err)
    }
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const abs = this.abs(path)
    if (abs === '/') return { name: '/', path: '/', type: 'dir', size: 0 }
    const parent = posixDirname(abs)
    const name = posixBasename(abs)
    let items: FileInfo[]
    try {
      items = await this.client.list(parent)
    } catch (err) {
      const e = err as { code?: number }
      if (e?.code === 550) return null
      wrap(err)
    }
    const hit = items.find((f) => f.name === name)
    return hit ? toEntry(parent, hit) : null
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const abs = this.abs(path)
    try {
      const size = await this.client.size(abs).catch(() => -1)
      if (size > maxBytes) throw new RemoteError(`File is ${size} bytes, exceeds limit of ${maxBytes}`, 'too_large')
      const chunks: Buffer[] = []
      let total = 0
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          total += chunk.length
          if (total > maxBytes) {
            cb(new RemoteError(`File exceeds limit of ${maxBytes} bytes`, 'too_large'))
            return
          }
          chunks.push(chunk)
          cb()
        }
      })
      await this.client.downloadTo(sink, abs)
      return Buffer.concat(chunks)
    } catch (err) {
      if (err instanceof RemoteError) throw err
      wrap(err)
    }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    try {
      await this.client.uploadFrom(Readable.from([data]), this.abs(path))
    } catch (err) {
      wrap(err)
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    try {
      await this.client.downloadTo(localPath, this.abs(remotePath))
    } catch (err) {
      wrap(err)
    }
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    try {
      await this.client.uploadFrom(localPath, this.abs(remotePath))
    } catch (err) {
      wrap(err)
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await this.client.remove(this.abs(path))
    } catch (err) {
      wrap(err)
    }
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    const abs = this.abs(path)
    if (abs === '/' || abs === this.baseDir) throw new RemoteError('Refusing to delete the base directory', 'invalid')
    try {
      if (recursive) await this.client.removeDir(abs)
      else await this.client.removeEmptyDir(abs)
    } catch (err) {
      wrap(err)
    }
  }

  async mkdir(path: string): Promise<void> {
    const abs = this.abs(path)
    try {
      await this.client.ensureDir(abs)
      await this.client.cd(this.baseDir).catch(() => undefined)
    } catch (err) {
      wrap(err)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await this.client.rename(this.abs(from), this.abs(to))
    } catch (err) {
      wrap(err)
    }
  }

  async close(): Promise<void> {
    this.client.close()
  }
}
