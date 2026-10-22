import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Credentials, ImportResult, Protocol, ServerInput, ServerRecord } from '@shared/types'
import type { Cipher } from './cipher'
import { parseCsv, toCsv } from './csv'

interface StoredSecrets {
  password?: string
  privateKey?: string
  passphrase?: string
}

interface StoredServer extends ServerRecord {
  insecureTls?: boolean
  secrets: StoredSecrets
}

interface StoreFile {
  version: 1
  servers: StoredServer[]
}

export const DEFAULT_PORTS: Record<Protocol, number> = { ftp: 21, ftps: 21, sftp: 22 }
const PROTOCOLS: Protocol[] = ['ftp', 'ftps', 'sftp']

export interface ServerSelector {
  ids?: string[]
  tag?: string
  query?: string
}

export type ServerWithTls = ServerRecord & { insecureTls: boolean }

/**
 * Persists server metadata + encrypted secrets to a single JSON file.
 * Public methods never return secrets except `credentials()`, which is only called by the connection layer.
 */
export class ServerStore {
  private servers: StoredServer[] = []
  private listeners = new Set<() => void>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreFile
      this.servers = Array.isArray(parsed.servers) ? parsed.servers : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.servers = []
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  private async persist(): Promise<void> {
    const data: StoreFile = { version: 1, servers: this.servers }
    const json = JSON.stringify(data, null, 2)
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      const tmp = join(dirname(this.filePath), `.servers.${process.pid}.tmp`)
      await fs.writeFile(tmp, json, { mode: 0o600 })
      await fs.rename(tmp, this.filePath)
    })
    await this.writeQueue
    this.emit()
  }

  private toPublic(s: StoredServer): ServerWithTls {
    const { secrets: _secrets, ...rest } = s
    void _secrets
    return { ...rest, insecureTls: s.insecureTls === true }
  }

  list(): ServerWithTls[] {
    return this.servers
      .map((s) => this.toPublic(s))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }

  get(id: string): ServerWithTls | undefined {
    const s = this.servers.find((x) => x.id === id)
    return s ? this.toPublic(s) : undefined
  }

  /** Resolve a reference given by an agent: exact id, or a unique case-insensitive name. */
  resolve(ref: string): ServerWithTls | undefined {
    const trimmed = ref.trim()
    const byId = this.servers.find((s) => s.id === trimmed)
    if (byId) return this.toPublic(byId)
    const lower = trimmed.toLowerCase()
    const byName = this.servers.filter((s) => s.name.toLowerCase() === lower)
    if (byName.length === 1) return this.toPublic(byName[0])
    if (byName.length > 1) throw new Error(`Server name "${trimmed}" is ambiguous (${byName.length} matches); use the id`)
    return undefined
  }

  /** Explicit ids keep the caller's order (batch runs in that order); otherwise sorted by name. */
  select(sel: ServerSelector): ServerWithTls[] {
    let result = this.list()
    if (sel.ids && sel.ids.length > 0) {
      const seen = new Set<string>()
      const ordered: ServerWithTls[] = []
      for (const ref of sel.ids) {
        const s = this.resolve(ref)
        if (!s) throw new Error(`Unknown server: ${ref}`)
        if (!seen.has(s.id)) {
          seen.add(s.id)
          ordered.push(s)
        }
      }
      result = ordered
    }
    if (sel.tag) {
      const tag = sel.tag.toLowerCase()
      result = result.filter((s) => s.tags.some((t) => t.toLowerCase() === tag))
    }
    if (sel.query) {
      const q = sel.query.toLowerCase()
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.host.toLowerCase().includes(q) ||
          s.notes.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q))
      )
    }
    return result
  }

  allTags(): string[] {
    const set = new Set<string>()
    for (const s of this.servers) for (const t of s.tags) set.add(t)
    return [...set].sort((a, b) => a.localeCompare(b))
  }

  credentials(id: string): Credentials {
    const s = this.servers.find((x) => x.id === id)
    if (!s) throw new Error(`Unknown server id: ${id}`)
    const out: Credentials = {}
    if (s.secrets.password) out.password = this.cipher.decrypt(s.secrets.password)
    if (s.secrets.privateKey) out.privateKey = this.cipher.decrypt(s.secrets.privateKey)
    if (s.secrets.passphrase) out.passphrase = this.cipher.decrypt(s.secrets.passphrase)
    return out
  }

  private validate(input: Partial<ServerInput>, isCreate: boolean): void {
    if (isCreate || input.name !== undefined) {
      if (!input.name || !input.name.trim()) throw new Error('name is required')
    }
    if (isCreate || input.host !== undefined) {
      if (!input.host || !input.host.trim()) throw new Error('host is required')
    }
    if (isCreate || input.protocol !== undefined) {
      if (!input.protocol || !PROTOCOLS.includes(input.protocol)) throw new Error('protocol must be ftp, ftps or sftp')
    }
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
      throw new Error('port must be between 1 and 65535')
    }
  }

  private applySecrets(target: StoredSecrets, input: Partial<ServerInput>): void {
    const set = (key: keyof StoredSecrets, value: string | undefined): void => {
      if (value === undefined) return
      if (value === '') delete target[key]
      else target[key] = this.cipher.encrypt(value)
    }
    set('password', input.password)
    set('privateKey', input.privateKey)
    set('passphrase', input.passphrase)
  }

  async create(input: ServerInput & { insecureTls?: boolean }): Promise<ServerWithTls> {
    this.validate(input, true)
    const now = new Date().toISOString()
    const s: StoredServer = {
      id: randomUUID(),
      name: input.name.trim(),
      host: input.host.trim(),
      port: input.port ?? DEFAULT_PORTS[input.protocol],
      protocol: input.protocol,
      username: (input.username ?? '').trim(),
      authType: input.authType ?? 'password',
      tags: normalizeTags(input.tags),
      notes: input.notes ?? '',
      rootPath: (input.rootPath ?? '').trim(),
      insecureTls: input.insecureTls === true,
      hasPassword: false,
      hasPrivateKey: false,
      createdAt: now,
      updatedAt: now,
      secrets: {}
    }
    this.applySecrets(s.secrets, input)
    s.hasPassword = !!s.secrets.password
    s.hasPrivateKey = !!s.secrets.privateKey
    this.servers.push(s)
    await this.persist()
    return this.toPublic(s)
  }

  async update(id: string, patch: Partial<ServerInput> & { insecureTls?: boolean }): Promise<ServerWithTls> {
    const s = this.servers.find((x) => x.id === id)
    if (!s) throw new Error(`Unknown server id: ${id}`)
    this.validate(patch, false)
    if (patch.name !== undefined) s.name = patch.name.trim()
    if (patch.host !== undefined) s.host = patch.host.trim()
    if (patch.protocol !== undefined) {
      const wasDefault = s.port === DEFAULT_PORTS[s.protocol]
      s.protocol = patch.protocol
      if (wasDefault && patch.port === undefined) s.port = DEFAULT_PORTS[patch.protocol]
    }
    if (patch.port !== undefined) s.port = patch.port
    if (patch.username !== undefined) s.username = patch.username.trim()
    if (patch.authType !== undefined) s.authType = patch.authType
    if (patch.tags !== undefined) s.tags = normalizeTags(patch.tags)
    if (patch.notes !== undefined) s.notes = patch.notes
    if (patch.rootPath !== undefined) s.rootPath = patch.rootPath.trim()
    if (patch.insecureTls !== undefined) s.insecureTls = patch.insecureTls
    this.applySecrets(s.secrets, patch)
    s.hasPassword = !!s.secrets.password
    s.hasPrivateKey = !!s.secrets.privateKey
    s.updatedAt = new Date().toISOString()
    await this.persist()
    return this.toPublic(s)
  }

  async remove(id: string): Promise<void> {
    const before = this.servers.length
    this.servers = this.servers.filter((s) => s.id !== id)
    if (this.servers.length === before) throw new Error(`Unknown server id: ${id}`)
    await this.persist()
  }

  async recordTest(id: string, ok: boolean, message: string): Promise<void> {
    const s = this.servers.find((x) => x.id === id)
    if (!s) return
    s.lastTestAt = new Date().toISOString()
    s.lastTestOk = ok
    s.lastTestMessage = message
    await this.persist()
  }

  /**
   * Import from CSV. Header row required. Recognised columns (case-insensitive):
   * name, host, port, protocol, username, password, tags, notes, root_path, private_key_path, passphrase, insecure_tls.
   * Rows whose name matches an existing server are updated (secrets only overwritten when non-empty).
   */
  async importCsv(text: string, readKeyFile?: (path: string) => Promise<string>): Promise<ImportResult> {
    const rows = parseCsv(text)
    const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] }
    if (rows.length < 2) {
      result.errors.push('CSV needs a header row and at least one data row')
      return result
    }
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'))
    const col = (row: string[], name: string): string | undefined => {
      const idx = header.indexOf(name)
      return idx >= 0 ? row[idx]?.trim() : undefined
    }
    if (!header.includes('name') || !header.includes('host')) {
      result.errors.push('CSV header must include at least "name" and "host"')
      return result
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const line = i + 1
      try {
        const name = col(row, 'name') ?? ''
        const host = col(row, 'host') ?? ''
        if (!name || !host) {
          result.skipped++
          continue
        }
        const protocolRaw = (col(row, 'protocol') ?? 'ftp').toLowerCase()
        const protocol = (PROTOCOLS.includes(protocolRaw as Protocol) ? protocolRaw : 'ftp') as Protocol
        const portRaw = col(row, 'port')
        const port = portRaw ? Number(portRaw) : undefined
        const tags = normalizeTags((col(row, 'tags') ?? '').split(/[;|,]/))
        const password = col(row, 'password')
        const passphrase = col(row, 'passphrase')
        const keyPath = col(row, 'private_key_path')
        let privateKey: string | undefined
        if (keyPath && readKeyFile) privateKey = await readKeyFile(keyPath)
        const insecureRaw = (col(row, 'insecure_tls') ?? '').toLowerCase()
        const input: ServerInput & { insecureTls?: boolean } = {
          name,
          host,
          port: port && Number.isFinite(port) ? port : undefined,
          protocol,
          username: col(row, 'username') ?? '',
          authType: privateKey ? 'key' : 'password',
          tags,
          notes: col(row, 'notes') ?? '',
          rootPath: col(row, 'root_path') ?? '',
          insecureTls: insecureRaw === 'true' || insecureRaw === '1' || insecureRaw === 'yes'
        }
        if (password) input.password = password
        if (privateKey) input.privateKey = privateKey
        if (passphrase) input.passphrase = passphrase
        const existing = this.servers.find((s) => s.name.toLowerCase() === name.toLowerCase())
        if (existing) {
          await this.update(existing.id, input)
          result.updated++
        } else {
          await this.create(input)
          result.created++
        }
      } catch (err) {
        result.errors.push(`line ${line}: ${(err as Error).message}`)
      }
    }
    return result
  }

  /** Export without secrets. */
  exportCsv(): string {
    const header = ['name', 'host', 'port', 'protocol', 'username', 'tags', 'notes', 'root_path', 'insecure_tls']
    const rows = this.list().map((s) => [
      s.name,
      s.host,
      String(s.port),
      s.protocol,
      s.username,
      s.tags.join(';'),
      s.notes,
      s.rootPath,
      s.insecureTls ? 'true' : ''
    ])
    return toCsv([header, ...rows])
  }
}

export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return []
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim()
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out
}
