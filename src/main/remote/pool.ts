import type { Credentials } from '@shared/types'
import { FtpRemoteClient } from './ftp'
import { SftpRemoteClient } from './sftp'
import { RemoteError, type ConnectableServer, type Connector, type RemoteClient } from './types'

interface Slot {
  client: RemoteClient | null
  connecting: Promise<RemoteClient> | null
  chain: Promise<unknown>
  lastUsed: number
  idleTimer: NodeJS.Timeout | null
  busy: boolean
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RemoteError) return err.code === 'remote' || err.code === 'connect'
  return true
}

export const defaultConnector: Connector = (server, creds) =>
  server.protocol === 'sftp' ? SftpRemoteClient.connect(server, creds) : FtpRemoteClient.connect(server, creds)

/**
 * One pooled connection per server, operations on the same server are serialised,
 * idle connections are closed after a timeout, and any error evicts the connection
 * so the next call reconnects cleanly.
 */
export class ConnectionPool {
  private slots = new Map<string, Slot>()

  constructor(
    private readonly connector: Connector,
    private readonly idleTimeoutMs: () => number,
    private readonly maxConnections: () => number = () => 6
  ) {}

  private slot(id: string): Slot {
    let s = this.slots.get(id)
    if (!s) {
      s = { client: null, connecting: null, chain: Promise.resolve(), lastUsed: 0, idleTimer: null, busy: false }
      this.slots.set(id, s)
    }
    return s
  }

  private armIdle(id: string, s: Slot): void {
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = setTimeout(() => void this.evict(id), this.idleTimeoutMs())
    s.idleTimer.unref?.()
  }

  async withClient<T>(
    server: ConnectableServer,
    getCreds: () => Credentials,
    fn: (client: RemoteClient) => Promise<T>
  ): Promise<T> {
    const s = this.slot(server.id)
    const attempt = async (): Promise<{ out: T } | { err: unknown; reused: boolean }> => {
      if (s.idleTimer) clearTimeout(s.idleTimer)
      const reused = s.client !== null
      if (!s.client) {
        await this.makeRoom()
        if (!s.connecting) s.connecting = this.connector(server, getCreds())
        try {
          s.client = await s.connecting
        } finally {
          s.connecting = null
        }
      }
      try {
        const out = await fn(s.client)
        s.lastUsed = Date.now()
        this.armIdle(server.id, s)
        return { out }
      } catch (err) {
        await this.evict(server.id)
        return { err, reused }
      }
    }
    const run = async (): Promise<T> => {
      s.busy = true
      try {
        const first = await attempt()
        if ('out' in first) return first.out
        // A reused connection may have been dropped by the server while idle; reconnect once
        // unless the error is clearly about the request itself.
        if (first.reused && isRetryable(first.err)) {
          const second = await attempt()
          if ('out' in second) return second.out
          throw second.err
        }
        throw first.err
      } finally {
        s.busy = false
      }
    }
    const p = s.chain.then(run, run)
    s.chain = p.catch(() => undefined)
    return p
  }

  /** Close least-recently-used idle connections until a new one fits under the global cap. */
  private async makeRoom(): Promise<void> {
    const cap = Math.max(1, this.maxConnections())
    while (this.activeCount() >= cap) {
      const idle = [...this.slots.entries()]
        .filter(([, s]) => s.client && !s.busy)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      if (idle.length === 0) return // everything is in use; let the caller's concurrency decide
      await this.evict(idle[0][0])
    }
  }

  async evict(id: string): Promise<void> {
    const s = this.slots.get(id)
    if (!s) return
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = null
    const c = s.client
    s.client = null
    if (c) await c.close().catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((id) => this.evict(id)))
  }

  activeCount(): number {
    let n = 0
    for (const s of this.slots.values()) if (s.client) n++
    return n
  }
}
