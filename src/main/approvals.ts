import { randomUUID } from 'node:crypto'
import type { ApprovalRequest } from '@shared/types'

interface Pending {
  req: ApprovalRequest
  resolve: (ok: boolean) => void
  timer: NodeJS.Timeout
}

/** Holds agent operations until the user approves or denies them in the app. */
export class ApprovalBroker {
  private pending = new Map<string, Pending>()
  private listeners = new Set<(list: ApprovalRequest[]) => void>()

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req)
  }

  request(tool: string, summary: string, serverNames: string[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const id = randomUUID()
      const req: ApprovalRequest = {
        id,
        ts: new Date().toISOString(),
        tool,
        summary,
        serverNames,
        expiresAt: new Date(Date.now() + this.timeoutMs).toISOString()
      }
      const timer = setTimeout(() => this.resolve(id, false), this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { req, resolve, timer })
      this.emit()
    })
  }

  resolve(id: string, approved: boolean): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(approved)
    this.emit()
    return true
  }

  resolveAll(approved: boolean): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, approved)
  }

  onChange(listener: (list: ApprovalRequest[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const list = this.list()
    for (const l of this.listeners) l(list)
  }
}
