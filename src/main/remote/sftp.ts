import { Client as SshClient, type SFTPWrapper } from 'ssh2'
import type { Credentials, RemoteEntry } from '@shared/types'
import {
  RemoteError,
  joinRemote,
  posixBasename,
  resolveRemotePath,
  type ConnectableServer,
  type RemoteClient
} from './types'

interface SftpStats {
  mode: number
  size: number
  mtime: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

function statsToEntry(dir: string, name: string, attrs: SftpStats): RemoteEntry {
  const type = attrs.isDirectory() ? 'dir' : attrs.isSymbolicLink() ? 'link' : attrs.isFile() ? 'file' : 'other'
  return {
    name,
    path: joinRemote(dir, name),
    type,
    size: attrs.size,
    modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : undefined,
    modifiedPrecision: attrs.mtime ? 'minute' : undefined,
    permissions: (attrs.mode & 0o777).toString(8).padStart(3, '0')
  }
}

function wrap(err: unknown): never {
  const e = err as { code?: number | string; message?: string }
  const msg = e?.message ?? String(err)
  // SFTP status code 2 = SSH_FX_NO_SUCH_FILE
  if (e?.code === 2 || /no such file/i.test(msg)) throw new RemoteError(msg, 'not_found')
  if (e?.code === 3 || /permission denied/i.test(msg)) throw new RemoteError(msg, 'remote')
  throw new RemoteError(msg, 'remote')
}

export class SftpRemoteClient implements RemoteClient {
  readonly baseDir: string

  private constructor(
    private readonly ssh: SshClient,
    private readonly sftp: SFTPWrapper,
    baseDir: string
  ) {
    this.baseDir = baseDir
  }

  static async connect(server: ConnectableServer, creds: Credentials): Promise<SftpRemoteClient> {
    const ssh = new SshClient()
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      ssh.on('ready', () => {
        ssh.sftp((err, s) => (err ? reject(err) : resolve(s)))
      })
      ssh.on('error', (err) => reject(err))
      ssh.connect({
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.authType === 'password' ? creds.password : undefined,
        privateKey: server.authType === 'key' ? creds.privateKey : undefined,
        passphrase: server.authType === 'key' ? creds.passphrase : undefined,
        readyTimeout: 30_000,
        keepaliveInterval: 15_000
      })
    }).catch((err: Error & { level?: string }) => {
      ssh.end()
      if (err.level === 'client-authentication' || /authentication/i.test(err.message)) {
        throw new RemoteError(`Authentication failed: ${err.message}`, 'auth')
      }
      throw new RemoteError(`Connect failed: ${err.message}`, 'connect')
    })
    const home = await new Promise<string>((resolve) => {
      sftp.realpath('.', (err, p) => resolve(err ? '/' : p))
    })
    const base = server.rootPath ? resolveRemotePath(home, server.rootPath) : home
    return new SftpRemoteClient(ssh, sftp, base)
  }

  private abs(p: string): string {
    return resolveRemotePath(this.baseDir, p)
  }

  private call<T>(fn: (cb: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        fn((err, value) => (err ? reject(err) : resolve(value)))
      } catch (err) {
        reject(err)
      }
    })
  }

  private voidCall(fn: (cb: (err: Error | null | undefined) => void) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        fn((err) => (err ? reject(err) : resolve()))
      } catch (err) {
        reject(err)
      }
    })
  }

  private rawStat(abs: string): Promise<SftpStats> {
    return this.call<SftpStats>((cb) => this.sftp.stat(abs, cb as never))
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const dir = this.abs(path)
    try {
      const items = await this.call<Array<{ filename: string; attrs: SftpStats }>>((cb) =>
        this.sftp.readdir(dir, cb as never)
      )
      return items
        .filter((f) => f.filename !== '.' && f.filename !== '..')
        .map((f) => statsToEntry(dir, f.filename, f.attrs))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      wrap(err)
    }
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const abs = this.abs(path)
    try {
      const attrs = await this.rawStat(abs)
      return statsToEntry(abs === '/' ? '' : abs.slice(0, abs.lastIndexOf('/')) || '/', posixBasename(abs) || '/', attrs)
    } catch (err) {
      const e = err as { code?: number }
      if (e?.code === 2) return null
      wrap(err)
    }
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const abs = this.abs(path)
    try {
      const attrs = await this.rawStat(abs)
      if (attrs.size > maxBytes) {
        throw new RemoteError(`File is ${attrs.size} bytes, exceeds limit of ${maxBytes}`, 'too_large')
      }
      return await this.call<Buffer>((cb) => this.sftp.readFile(abs, cb as never))
    } catch (err) {
      if (err instanceof RemoteError) throw err
      wrap(err)
    }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    try {
      await this.voidCall((cb) => this.sftp.writeFile(this.abs(path), data, cb))
    } catch (err) {
      wrap(err)
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    try {
      await this.voidCall((cb) => this.sftp.fastGet(this.abs(remotePath), localPath, cb))
    } catch (err) {
      wrap(err)
    }
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    try {
      await this.voidCall((cb) => this.sftp.fastPut(localPath, this.abs(remotePath), cb))
    } catch (err) {
      wrap(err)
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await this.voidCall((cb) => this.sftp.unlink(this.abs(path), cb))
    } catch (err) {
      wrap(err)
    }
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    const abs = this.abs(path)
    if (abs === '/' || abs === this.baseDir) throw new RemoteError('Refusing to delete the base directory', 'invalid')
    try {
      if (recursive) await this.rmTree(abs)
      else await this.voidCall((cb) => this.sftp.rmdir(abs, cb))
    } catch (err) {
      if (err instanceof RemoteError) throw err
      wrap(err)
    }
  }

  private async rmTree(dir: string): Promise<void> {
    const items = await this.call<Array<{ filename: string; attrs: SftpStats }>>((cb) =>
      this.sftp.readdir(dir, cb as never)
    )
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue
      const p = joinRemote(dir, item.filename)
      if (item.attrs.isDirectory()) await this.rmTree(p)
      else await this.voidCall((cb) => this.sftp.unlink(p, cb))
    }
    await this.voidCall((cb) => this.sftp.rmdir(dir, cb))
  }

  async mkdir(path: string): Promise<void> {
    const abs = this.abs(path)
    const parts = abs.split('/').filter(Boolean)
    let cur = ''
    for (const part of parts) {
      cur += '/' + part
      const exists = await this.rawStat(cur).then(
        (a) => a.isDirectory(),
        () => false
      )
      if (exists) continue
      try {
        await this.voidCall((cb) => this.sftp.mkdir(cur, cb))
      } catch (err) {
        wrap(err)
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await this.voidCall((cb) => this.sftp.rename(this.abs(from), this.abs(to), cb))
    } catch (err) {
      wrap(err)
    }
  }

  async close(): Promise<void> {
    this.sftp.end()
    this.ssh.end()
  }
}
