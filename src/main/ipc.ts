import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import type { ServerInput, Settings } from '@shared/types'
import type { ServerStore } from './store/servers'
import type { SettingsStore } from './store/settings'
import type { ActivityLog } from './activity'
import type { ApprovalBroker } from './approvals'
import type { ConnectionPool } from './remote/pool'
import type { TokenFile } from './mcp/token'
import type { McpHttpServer } from './mcp/http'
import type { McpStatus } from '@shared/types'

export interface AppContext {
  store: ServerStore
  settings: SettingsStore
  activity: ActivityLog
  approvals: ApprovalBroker
  pool: ConnectionPool
  token: TokenFile
  http: McpHttpServer
  bridgePath: string
  version: string
  getWindow: () => BrowserWindow | null
  mcpStatus: () => McpStatus
  restartMcp: () => Promise<void>
}

type ServerPatch = Partial<ServerInput> & { insecureTls?: boolean }

export function registerIpc(ctx: AppContext): void {
  const send = (channel: string, payload: unknown): void => {
    const win = ctx.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  ctx.store.onChange(() => send('servers:changed', ctx.store.list()))
  ctx.activity.onAdd((entry) => send('activity:added', entry))
  ctx.approvals.onChange((list) => send('approvals:changed', list))
  ctx.settings.onChange((s) => send('settings:changed', s))

  // ---- servers
  ipcMain.handle('servers:list', () => ctx.store.list())
  ipcMain.handle('servers:tags', () => ctx.store.allTags())
  ipcMain.handle('servers:create', (_e, input: ServerInput & { insecureTls?: boolean }) => ctx.store.create(input))
  ipcMain.handle('servers:update', (_e, id: string, patch: ServerPatch) => ctx.store.update(id, patch))
  ipcMain.handle('servers:remove', async (_e, id: string) => {
    await ctx.pool.evict(id)
    await ctx.store.remove(id)
  })
  ipcMain.handle('servers:test', async (_e, id: string) => {
    const s = ctx.store.get(id)
    if (!s) throw new Error('Unknown server')
    const started = Date.now()
    await ctx.pool.evict(id)
    try {
      const base = await ctx.pool.withClient(s, () => ctx.store.credentials(id), async (c) => c.baseDir)
      const msg = `ok, base dir ${base} (${Date.now() - started} ms)`
      await ctx.store.recordTest(id, true, msg)
      return { ok: true, message: msg }
    } catch (err) {
      const msg = (err as Error).message
      await ctx.store.recordTest(id, false, msg)
      return { ok: false, message: msg }
    }
  })
  ipcMain.handle('servers:importCsv', async () => {
    const win = ctx.getWindow() ?? undefined
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Import servers from CSV',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const text = await fs.readFile(res.filePaths[0], 'utf8')
    return ctx.store.importCsv(text, (p) => fs.readFile(p, 'utf8'))
  })
  ipcMain.handle('servers:exportCsv', async () => {
    const win = ctx.getWindow() ?? undefined
    const res = await dialog.showSaveDialog(win as BrowserWindow, {
      title: 'Export servers (no passwords)',
      defaultPath: 'ftp-man-servers.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return null
    await fs.writeFile(res.filePath, ctx.store.exportCsv(), 'utf8')
    return res.filePath
  })
  ipcMain.handle('servers:pickKeyFile', async () => {
    const win = ctx.getWindow() ?? undefined
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Choose private key',
      defaultPath: `${app.getPath('home')}/.ssh`,
      properties: ['openFile', 'showHiddenFiles']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return fs.readFile(res.filePaths[0], 'utf8')
  })

  // ---- settings / mcp
  ipcMain.handle('settings:get', () => ctx.settings.get())
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    const before = ctx.settings.get()
    const after = await ctx.settings.set(patch)
    if (before.mcpPort !== after.mcpPort || before.mcpEnabled !== after.mcpEnabled) await ctx.restartMcp()
    return after
  })
  ipcMain.handle('mcp:status', () => ctx.mcpStatus())
  ipcMain.handle('mcp:restart', () => ctx.restartMcp())
  ipcMain.handle('mcp:token', () => ctx.token.get())
  ipcMain.handle('mcp:regenerateToken', async () => {
    await ctx.token.regenerate()
    return ctx.token.get()
  })
  ipcMain.handle('mcp:copy', (_e, text: string) => clipboard.writeText(text))

  // ---- activity / approvals
  ipcMain.handle('activity:list', () => ctx.activity.list())
  ipcMain.handle('activity:clear', () => ctx.activity.clear())
  ipcMain.handle('approvals:list', () => ctx.approvals.list())
  ipcMain.handle('approvals:resolve', (_e, id: string, approved: boolean) => ctx.approvals.resolve(id, approved))

  // ---- misc
  ipcMain.handle('app:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('app:version', () => ctx.version)
}

// ---- remote file browser (UI-initiated, same pool/adapters as MCP) ----------------------
export function registerRemoteIpc(ctx: AppContext): void {
  const withServer = async <T>(id: string, fn: (c: import('./remote/types').RemoteClient) => Promise<T>): Promise<T> => {
    const s = ctx.store.get(id)
    if (!s) throw new Error('Unknown server')
    return ctx.pool.withClient(s, () => ctx.store.credentials(id), fn)
  }
  const win = (): BrowserWindow | undefined => ctx.getWindow() ?? undefined

  ipcMain.handle('remote:list', (_e, id: string, path: string) =>
    withServer(id, async (c) => ({ baseDir: c.baseDir, entries: await c.list(path) }))
  )
  ipcMain.handle('remote:read', (_e, id: string, path: string, maxBytes: number) =>
    withServer(id, async (c) => {
      const buf = await c.readFile(path, maxBytes)
      const text = buf.toString('utf8')
      const binary = buf.subarray(0, 8000).includes(0)
      return { size: buf.length, binary, text: binary ? '' : text }
    })
  )
  ipcMain.handle('remote:mkdir', (_e, id: string, path: string) => withServer(id, (c) => c.mkdir(path)))
  ipcMain.handle('remote:rename', (_e, id: string, from: string, to: string) => withServer(id, (c) => c.rename(from, to)))
  ipcMain.handle('remote:delete', (_e, id: string, path: string, isDir: boolean) =>
    withServer(id, (c) => (isDir ? c.deleteDir(path, true) : c.deleteFile(path)))
  )
  ipcMain.handle('remote:download', async (_e, id: string, remotePath: string, suggestedName: string) => {
    const res = await dialog.showSaveDialog(win() as BrowserWindow, { defaultPath: suggestedName })
    if (res.canceled || !res.filePath) return null
    await withServer(id, (c) => c.download(remotePath, res.filePath))
    return res.filePath
  })
  ipcMain.handle('remote:upload', async (_e, id: string, remoteDir: string) => {
    const res = await dialog.showOpenDialog(win() as BrowserWindow, { properties: ['openFile', 'multiSelections'] })
    if (res.canceled || res.filePaths.length === 0) return []
    const uploaded: string[] = []
    for (const local of res.filePaths) {
      const name = local.split('/').pop() as string
      const target = remoteDir === '/' ? `/${name}` : `${remoteDir.replace(/\/$/, '')}/${name}`
      await withServer(id, (c) => c.upload(local, target))
      uploaded.push(target)
    }
    return uploaded
  })
  ipcMain.handle('remote:disconnect', (_e, id: string) => ctx.pool.evict(id))
}
