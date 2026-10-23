import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { ApprovalMode, RemoteEntry, ServerRecord, Settings } from '@shared/types'
import type { ServerStore, ServerWithTls } from '../store/servers'
import type { ConnectionPool } from '../remote/pool'
import type { RemoteClient } from '../remote/types'
import { RemoteError, joinRemote, posixDirname } from '../remote/types'
import type { ApprovalBroker } from '../approvals'
import type { ActivityLog } from '../activity'

export interface McpDeps {
  store: ServerStore
  settings: () => Settings
  pool: ConnectionPool
  approvals: ApprovalBroker
  activity: ActivityLog
  version: string
}

type Kind = 'read' | 'write' | 'delete'

const INSTRUCTIONS = `FTP Man exposes the user's saved FTP/FTPS/SFTP servers. Credentials are stored locally and are never
returned by any tool. Reference a server by its "id" or its exact "name" (from list_servers).

Paths: absolute paths ("/var/www/x") are used as-is; relative paths ("public_html/x") resolve against the
server's configured root directory (or the login directory). Use list_files with no path to see the root.

Doing the same thing on many servers: call "batch" with a tag or a list of servers and one operation.
It runs sequentially by default (concurrency 1), isolates failures per server, and returns one result per server.
Leave concurrency at 1 unless the user asks otherwise: shared hosts often allow only one login per client at a time.

Write operations (write_file, upload_file, delete_path, make_directory, rename_path, and batch with those)
may require the user to approve them in the FTP Man app, depending on the user's approval policy (by default only
delete_path asks); if a call is denied or times out, tell the user.`

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] }
}

function errMessage(err: unknown): string {
  if (err instanceof RemoteError) return `[${err.code}] ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

function publicServer(s: ServerWithTls): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    protocol: s.protocol,
    username: s.username,
    tags: s.tags,
    notes: s.notes || undefined,
    root_path: s.rootPath || undefined,
    last_test_ok: s.lastTestOk,
    last_test_at: s.lastTestAt
  }
}

function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_')
}

const serverRef = z.string().min(1).describe('Server id or exact server name (see list_servers)')
const pathArg = z.string().describe('Remote path; absolute or relative to the server root directory')

const opSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('test_connection') }),
  z.object({ type: z.literal('list_files'), path: pathArg.optional() }),
  z.object({ type: z.literal('get_file_info'), path: pathArg }),
  z.object({
    type: z.literal('read_file'),
    path: pathArg,
    encoding: z.enum(['utf8', 'base64']).optional()
  }),
  z.object({
    type: z.literal('write_file'),
    path: pathArg,
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional(),
    create_dirs: z.boolean().optional()
  }),
  z.object({
    type: z.literal('upload_file'),
    local_path: z.string().describe('Absolute local file path on this Mac'),
    remote_path: pathArg,
    create_dirs: z.boolean().optional()
  }),
  z.object({
    type: z.literal('download_file'),
    remote_path: pathArg,
    local_path: z
      .string()
      .describe('Local destination. Include "{server}" to substitute the server name, otherwise it is treated as a directory and files are saved under <local_path>/<server>/')
  }),
  z.object({ type: z.literal('delete_path'), path: pathArg, recursive: z.boolean().optional() }),
  z.object({ type: z.literal('make_directory'), path: pathArg }),
  z.object({ type: z.literal('rename_path'), from: pathArg, to: pathArg }),
  z.object({
    type: z.literal('find_files'),
    path: pathArg.optional(),
    pattern: z.string(),
    max_depth: z.number().int().min(0).max(10).optional(),
    max_results: z.number().int().min(1).max(2000).optional()
  })
])
type Operation = z.infer<typeof opSchema>

const WRITE_OPS = new Set<Operation['type']>(['write_file', 'upload_file', 'delete_path', 'make_directory', 'rename_path'])

function kindOf(type: Operation['type']): Kind {
  if (type === 'delete_path') return 'delete'
  return WRITE_OPS.has(type) ? 'write' : 'read'
}

function needsApproval(mode: ApprovalMode, kind: Kind): boolean {
  switch (mode) {
    case 'all':
      return true
    case 'writes':
      return kind !== 'read'
    case 'deletes':
      return kind === 'delete'
    default:
      return false
  }
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'ftp-man', version: deps.version }, { instructions: INSTRUCTIONS })

  const resolveServer = (ref: string): ServerWithTls => {
    const s = deps.store.resolve(ref)
    if (!s) throw new Error(`Unknown server "${ref}". Call list_servers to see available servers.`)
    return s
  }

  /** Enforce read-only mode and the approval policy, then run and log the operation. */
  const guarded = async <T>(
    tool: string,
    kind: Kind,
    servers: ServerRecord[],
    summary: string,
    run: () => Promise<T>
  ): Promise<T> => {
    const settings = deps.settings()
    if (kind !== 'read' && settings.readOnly) {
      throw new Error('FTP Man is in read-only mode; ask the user to disable it in the app to allow writes')
    }
    if (needsApproval(settings.approvalMode, kind)) {
      const approved = await deps.approvals.request(
        tool,
        summary,
        servers.map((s) => s.name)
      )
      if (!approved) throw new Error('The user denied this operation in FTP Man (or it timed out)')
    }
    const started = Date.now()
    try {
      const out = await run()
      deps.activity.add({
        tool,
        serverId: servers.length === 1 ? servers[0].id : undefined,
        serverName: servers.length === 1 ? servers[0].name : `${servers.length} servers`,
        summary,
        ok: true,
        durationMs: Date.now() - started
      })
      return out
    } catch (err) {
      deps.activity.add({
        tool,
        serverId: servers.length === 1 ? servers[0].id : undefined,
        serverName: servers.length === 1 ? servers[0].name : `${servers.length} servers`,
        summary,
        ok: false,
        durationMs: Date.now() - started,
        error: errMessage(err)
      })
      throw err
    }
  }

  const withClient = <T>(s: ServerWithTls, fn: (c: RemoteClient) => Promise<T>): Promise<T> =>
    deps.pool.withClient(s, () => deps.store.credentials(s.id), fn)

  const findFiles = async (
    client: RemoteClient,
    start: string,
    pattern: string,
    maxDepth: number,
    maxResults: number
  ): Promise<{ matches: RemoteEntry[]; truncated: boolean; scanned_dirs: number }> => {
    const re = pattern.includes('*') || pattern.includes('?') ? globToRegExp(pattern) : null
    const matches: RemoteEntry[] = []
    let scanned = 0
    let truncated = false
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (truncated) return
      scanned++
      let entries: RemoteEntry[]
      try {
        entries = await client.list(dir)
      } catch {
        return
      }
      for (const e of entries) {
        const hit = re ? re.test(e.name) : e.name.toLowerCase().includes(pattern.toLowerCase())
        if (hit) {
          matches.push(e)
          if (matches.length >= maxResults) {
            truncated = true
            return
          }
        }
      }
      if (depth >= maxDepth) return
      for (const e of entries) {
        if (e.type === 'dir') await walk(e.path, depth + 1)
        if (truncated) return
      }
    }
    await walk(start, 0)
    return { matches, truncated, scanned_dirs: scanned }
  }

  /** Execute one operation against one server; shared by single tools and batch. */
  const execute = async (s: ServerWithTls, op: Operation): Promise<unknown> => {
    const settings = deps.settings()
    switch (op.type) {
      case 'test_connection': {
        const started = Date.now()
        await deps.pool.evict(s.id) // always prove a fresh connection works
        try {
          const base = await withClient(s, async (c) => c.baseDir)
          await deps.store.recordTest(s.id, true, `ok (${Date.now() - started} ms)`)
          return { ok: true, base_dir: base, latency_ms: Date.now() - started }
        } catch (err) {
          await deps.store.recordTest(s.id, false, errMessage(err))
          throw err
        }
      }
      case 'list_files': {
        const p = op.path ?? ''
        return withClient(s, async (c) => ({ path: p || c.baseDir, entries: await c.list(p) }))
      }
      case 'get_file_info':
        return withClient(s, async (c) => (await c.stat(op.path)) ?? { exists: false, path: op.path })
      case 'read_file': {
        const buf = await withClient(s, (c) => c.readFile(op.path, settings.maxTextBytes))
        if (op.encoding === 'base64') return { path: op.path, size: buf.length, encoding: 'base64', content: buf.toString('base64') }
        const text = buf.toString('utf8')
        const binary = text.includes('�') && buf.some((b) => b === 0)
        if (binary) return { path: op.path, size: buf.length, encoding: 'base64', content: buf.toString('base64'), note: 'binary file' }
        return { path: op.path, size: buf.length, encoding: 'utf8', content: text }
      }
      case 'write_file': {
        const data = Buffer.from(op.content, op.encoding === 'base64' ? 'base64' : 'utf8')
        if (data.length > settings.maxTextBytes) throw new Error(`content exceeds ${settings.maxTextBytes} bytes; use upload_file`)
        await withClient(s, async (c) => {
          if (op.create_dirs) await c.mkdir(posixDirname(op.path.startsWith('/') ? op.path : joinRemote(c.baseDir, op.path)))
          await c.writeFile(op.path, data)
        })
        return { ok: true, path: op.path, bytes: data.length }
      }
      case 'upload_file': {
        const st = await fs.stat(op.local_path)
        if (!st.isFile()) throw new Error(`local_path is not a file: ${op.local_path}`)
        await withClient(s, async (c) => {
          if (op.create_dirs) await c.mkdir(posixDirname(op.remote_path.startsWith('/') ? op.remote_path : joinRemote(c.baseDir, op.remote_path)))
          await c.upload(op.local_path, op.remote_path)
        })
        return { ok: true, remote_path: op.remote_path, bytes: st.size }
      }
      case 'download_file': {
        const local = op.local_path.includes('{server}')
          ? op.local_path.replace(/\{server\}/g, safeName(s.name))
          : op.local_path
        await fs.mkdir(dirname(local), { recursive: true })
        await withClient(s, (c) => c.download(op.remote_path, local))
        const st = await fs.stat(local)
        return { ok: true, local_path: local, bytes: st.size }
      }
      case 'delete_path': {
        await withClient(s, async (c) => {
          const info = await c.stat(op.path)
          if (!info) throw new RemoteError(`No such path: ${op.path}`, 'not_found')
          if (info.type === 'dir') await c.deleteDir(op.path, op.recursive === true)
          else await c.deleteFile(op.path)
        })
        return { ok: true, path: op.path }
      }
      case 'make_directory':
        await withClient(s, (c) => c.mkdir(op.path))
        return { ok: true, path: op.path }
      case 'rename_path':
        await withClient(s, (c) => c.rename(op.from, op.to))
        return { ok: true, from: op.from, to: op.to }
      case 'find_files':
        return withClient(s, (c) =>
          findFiles(c, op.path ?? '', op.pattern, op.max_depth ?? 4, op.max_results ?? 200)
        )
    }
  }

  const summarize = (op: Operation): string => {
    switch (op.type) {
      case 'test_connection':
        return 'test connection'
      case 'list_files':
        return `list ${op.path || '(root)'}`
      case 'get_file_info':
        return `info ${op.path}`
      case 'read_file':
        return `read ${op.path}`
      case 'write_file':
        return `write ${op.path} (${Buffer.byteLength(op.content, op.encoding === 'base64' ? 'base64' : 'utf8')} bytes)`
      case 'upload_file':
        return `upload ${op.local_path} → ${op.remote_path}`
      case 'download_file':
        return `download ${op.remote_path} → ${op.local_path}`
      case 'delete_path':
        return `delete ${op.path}${op.recursive ? ' (recursive)' : ''}`
      case 'make_directory':
        return `mkdir ${op.path}`
      case 'rename_path':
        return `rename ${op.from} → ${op.to}`
      case 'find_files':
        return `find "${op.pattern}" in ${op.path || '(root)'}`
    }
  }

  const single = async (toolName: string, ref: string, op: Operation): Promise<CallToolResult> => {
    try {
      const s = resolveServer(ref)
      const out = await guarded(toolName, kindOf(op.type), [s], `${s.name}: ${summarize(op)}`, () => execute(s, op))
      return ok(out)
    } catch (err) {
      return fail(errMessage(err))
    }
  }

  // ---- read-only tools -------------------------------------------------------------------

  server.registerTool(
    'list_servers',
    {
      title: 'List servers',
      description: 'List saved servers (never includes credentials). Filter by tag and/or free-text query.',
      inputSchema: {
        tag: z.string().optional().describe('Only servers having this tag (case-insensitive)'),
        query: z.string().optional().describe('Substring match on name, host, notes or tags')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ tag, query }) => {
      try {
        const servers = deps.store.select({ tag, query })
        return ok({
          count: servers.length,
          available_tags: deps.store.allTags(),
          servers: servers.map(publicServer)
        })
      } catch (err) {
        return fail(errMessage(err))
      }
    }
  )

  server.registerTool(
    'test_connection',
    {
      title: 'Test connection',
      description: 'Connect to a server and report the resolved base directory and latency.',
      inputSchema: { server: serverRef },
      annotations: { readOnlyHint: true }
    },
    ({ server: ref }) => single('test_connection', ref, { type: 'test_connection' })
  )

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description: 'List a remote directory. Omit path for the server root directory.',
      inputSchema: { server: serverRef, path: pathArg.optional() },
      annotations: { readOnlyHint: true }
    },
    ({ server: ref, path }) => single('list_files', ref, { type: 'list_files', path })
  )

  server.registerTool(
    'get_file_info',
    {
      title: 'Get file info',
      description: 'Stat a remote path (type, size, modified time). Returns exists:false when missing.',
      inputSchema: { server: serverRef, path: pathArg },
      annotations: { readOnlyHint: true }
    },
    ({ server: ref, path }) => single('get_file_info', ref, { type: 'get_file_info', path })
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description: 'Read a remote file and return its content (utf8 text, or base64 for binary). Size-limited; use download_file for big files.',
      inputSchema: {
        server: serverRef,
        path: pathArg,
        encoding: z.enum(['utf8', 'base64']).optional().describe('Force an encoding; default auto-detects')
      },
      annotations: { readOnlyHint: true }
    },
    ({ server: ref, path, encoding }) => single('read_file', ref, { type: 'read_file', path, encoding })
  )

  server.registerTool(
    'find_files',
    {
      title: 'Find files',
      description: 'Recursively search a remote directory tree for names matching a glob (e.g. "*.php") or substring.',
      inputSchema: {
        server: serverRef,
        path: pathArg.optional(),
        pattern: z.string().describe('Glob (* and ?) or plain substring, case-insensitive'),
        max_depth: z.number().int().min(0).max(10).optional().describe('Default 4'),
        max_results: z.number().int().min(1).max(2000).optional().describe('Default 200')
      },
      annotations: { readOnlyHint: true }
    },
    ({ server: ref, ...rest }) => single('find_files', ref, { type: 'find_files', ...rest })
  )

  server.registerTool(
    'download_file',
    {
      title: 'Download file',
      description: 'Download a remote file to a local path on this Mac.',
      inputSchema: {
        server: serverRef,
        remote_path: pathArg,
        local_path: z.string().describe('Absolute local destination file path')
      },
      annotations: { readOnlyHint: true }
    },
    ({ server: ref, remote_path, local_path }) =>
      single('download_file', ref, { type: 'download_file', remote_path, local_path })
  )

  // ---- write tools -----------------------------------------------------------------------

  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description: 'Create or overwrite a remote file with the given text content.',
      inputSchema: {
        server: serverRef,
        path: pathArg,
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).optional(),
        create_dirs: z.boolean().optional().describe('Create missing parent directories')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    ({ server: ref, ...rest }) => single('write_file', ref, { type: 'write_file', ...rest })
  )

  server.registerTool(
    'upload_file',
    {
      title: 'Upload file',
      description: 'Upload a local file from this Mac to a remote path.',
      inputSchema: {
        server: serverRef,
        local_path: z.string().describe('Absolute local file path'),
        remote_path: pathArg,
        create_dirs: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    ({ server: ref, ...rest }) => single('upload_file', ref, { type: 'upload_file', ...rest })
  )

  server.registerTool(
    'delete_path',
    {
      title: 'Delete path',
      description: 'Delete a remote file or directory. Directories need recursive:true unless empty.',
      inputSchema: { server: serverRef, path: pathArg, recursive: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    ({ server: ref, ...rest }) => single('delete_path', ref, { type: 'delete_path', ...rest })
  )

  server.registerTool(
    'make_directory',
    {
      title: 'Make directory',
      description: 'Create a remote directory (and parents).',
      inputSchema: { server: serverRef, path: pathArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    ({ server: ref, path }) => single('make_directory', ref, { type: 'make_directory', path })
  )

  server.registerTool(
    'rename_path',
    {
      title: 'Rename / move',
      description: 'Rename or move a remote file or directory.',
      inputSchema: { server: serverRef, from: pathArg, to: pathArg },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    ({ server: ref, from, to }) => single('rename_path', ref, { type: 'rename_path', from, to })
  )

  // ---- batch -----------------------------------------------------------------------------

  server.registerTool(
    'batch',
    {
      title: 'Batch operation',
      description:
        'Run ONE operation across MANY servers (selected by tag and/or explicit list), sequentially by default. ' +
        'Returns a per-server result; a failure on one server does not stop the others unless stop_on_error is set. ' +
        'Keep the default concurrency 1: many shared hosts serve several domains from one machine and reject a second ' +
        'simultaneous login ("connection allow per one host"). ' +
        'Operation types: test_connection, list_files, get_file_info, read_file, write_file, upload_file, download_file, delete_path, make_directory, rename_path, find_files.',
      inputSchema: {
        servers: z.array(serverRef).optional().describe('Explicit server ids/names'),
        tag: z.string().optional().describe('Select all servers with this tag'),
        operation: opSchema,
        concurrency: z.number().int().min(1).max(10).optional().describe('Parallel servers; default 1 (sequential)'),
        stop_on_error: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    async ({ servers: refs, tag, operation, concurrency, stop_on_error }) => {
      try {
        if ((!refs || refs.length === 0) && !tag) return fail('Provide "servers" and/or "tag"')
        const targets = deps.store.select({ ids: refs, tag })
        if (targets.length === 0) return fail('No servers matched the selection')
        const summary = `${summarize(operation)} on ${targets.length} server(s)`

        const results = await guarded('batch', kindOf(operation.type), targets, summary, async () => {
          const out: Array<Record<string, unknown>> = new Array(targets.length)
          let stopped = false
          let next = 0
          const worker = async (): Promise<void> => {
            while (!stopped) {
              const i = next++
              if (i >= targets.length) return
              const s = targets[i]
              const started = Date.now()
              try {
                const result = await execute(s, operation)
                out[i] = { server: s.name, id: s.id, ok: true, duration_ms: Date.now() - started, result }
              } catch (err) {
                out[i] = { server: s.name, id: s.id, ok: false, duration_ms: Date.now() - started, error: errMessage(err) }
                if (stop_on_error) stopped = true
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(concurrency ?? 1, targets.length) }, worker))
          return out.filter(Boolean)
        })
        const okCount = results.filter((r) => r.ok).length
        return ok({
          operation: operation.type,
          total: targets.length,
          succeeded: okCount,
          failed: results.length - okCount,
          skipped: targets.length - results.length,
          results
        })
      } catch (err) {
        return fail(errMessage(err))
      }
    }
  )

  return server
}
