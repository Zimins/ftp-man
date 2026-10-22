import type { Credentials, RemoteEntry, ServerRecord } from '@shared/types'

export interface RemoteClient {
  /** Directory used to resolve relative paths (server rootPath or the login directory). */
  readonly baseDir: string
  list(path: string): Promise<RemoteEntry[]>
  stat(path: string): Promise<RemoteEntry | null>
  readFile(path: string, maxBytes: number): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  download(remotePath: string, localPath: string): Promise<void>
  upload(localPath: string, remotePath: string): Promise<void>
  deleteFile(path: string): Promise<void>
  deleteDir(path: string, recursive: boolean): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  close(): Promise<void>
}

export type ConnectableServer = ServerRecord & { insecureTls?: boolean }

export type Connector = (server: ConnectableServer, creds: Credentials) => Promise<RemoteClient>

export class RemoteError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'too_large' | 'connect' | 'auth' | 'remote' | 'invalid'
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

/** Resolve a user/agent-supplied path against the base directory. Always returns a posix path. */
export function resolveRemotePath(baseDir: string, path: string): string {
  const p = (path ?? '').trim()
  if (!p || p === '.') return baseDir || '/'
  const joined = p.startsWith('/') ? p : `${baseDir.replace(/\/+$/, '')}/${p}`
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  if (i <= 0) return '/'
  return p.slice(0, i)
}

export function posixBasename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export function joinRemote(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}
