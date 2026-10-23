export type Protocol = 'ftp' | 'ftps' | 'sftp'
export type AuthType = 'password' | 'key'

/** Server metadata that is safe to show in the UI and to MCP clients. Never contains secrets. */
export interface ServerRecord {
  id: string
  name: string
  host: string
  port: number
  protocol: Protocol
  username: string
  authType: AuthType
  tags: string[]
  notes: string
  /** Optional default working directory used when a relative path is given. */
  rootPath: string
  hasPassword: boolean
  hasPrivateKey: boolean
  createdAt: string
  updatedAt: string
  lastTestAt?: string
  lastTestOk?: boolean
  lastTestMessage?: string
}

/** Input for create/update. Secret fields are optional; omitted = unchanged, empty string = clear. */
export interface ServerInput {
  name: string
  host: string
  port?: number
  protocol: Protocol
  username: string
  authType?: AuthType
  tags?: string[]
  notes?: string
  rootPath?: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface Credentials {
  password?: string
  privateKey?: string
  passphrase?: string
}

/** none: never ask · deletes: only delete_path · writes: anything that changes the server · all: every call. */
export type ApprovalMode = 'none' | 'deletes' | 'writes' | 'all'

export interface Settings {
  mcpEnabled: boolean
  mcpPort: number
  approvalMode: ApprovalMode
  readOnly: boolean
  /** Max bytes returned by read_file / accepted by write_file as inline text. */
  maxTextBytes: number
  /** Seconds before an idle connection in the pool is closed. */
  idleTimeoutSec: number
  /** Global cap on open connections; shared hosts often allow ~10 per client IP across all their domains. */
  maxConnections: number
  /** UI language; 'system' follows the OS locale. */
  language: 'system' | 'ko' | 'en'
}

export interface McpStatus {
  running: boolean
  port: number
  url: string
  tokenFile: string
  bridgePath: string
  error?: string
}

export interface ActivityEntry {
  id: string
  ts: string
  tool: string
  serverId?: string
  serverName?: string
  summary: string
  ok: boolean
  durationMs: number
  error?: string
}

export interface ApprovalRequest {
  id: string
  ts: string
  tool: string
  summary: string
  serverNames: string[]
  /** Auto-deny deadline (ISO). */
  expiresAt: string
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  errors: string[]
}

export interface RemoteEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  modifiedAt?: string
  /** 'day' when the server only reported a date (typical FTP LIST for files older than ~6 months). */
  modifiedPrecision?: 'minute' | 'day'
  permissions?: string
}
