import { contextBridge, ipcRenderer } from 'electron'
import type { ActivityEntry, ApprovalRequest, ImportResult, McpStatus, RemoteEntry, ServerInput, ServerRecord, Settings } from '@shared/types'

type ServerPublic = ServerRecord & { insecureTls: boolean }
type ServerPatch = Partial<ServerInput> & { insecureTls?: boolean }

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const api = {
  servers: {
    list: (): Promise<ServerPublic[]> => ipcRenderer.invoke('servers:list'),
    tags: (): Promise<string[]> => ipcRenderer.invoke('servers:tags'),
    create: (input: ServerInput & { insecureTls?: boolean }): Promise<ServerPublic> => ipcRenderer.invoke('servers:create', input),
    update: (id: string, patch: ServerPatch): Promise<ServerPublic> => ipcRenderer.invoke('servers:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('servers:remove', id),
    test: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('servers:test', id),
    importCsv: (): Promise<ImportResult | null> => ipcRenderer.invoke('servers:importCsv'),
    exportCsv: (): Promise<string | null> => ipcRenderer.invoke('servers:exportCsv'),
    pickKeyFile: (): Promise<string | null> => ipcRenderer.invoke('servers:pickKeyFile'),
    onChanged: (cb: (list: ServerPublic[]) => void) => on('servers:changed', cb)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
    onChanged: (cb: (s: Settings) => void) => on('settings:changed', cb)
  },
  mcp: {
    status: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:status'),
    restart: (): Promise<void> => ipcRenderer.invoke('mcp:restart'),
    token: (): Promise<string> => ipcRenderer.invoke('mcp:token'),
    regenerateToken: (): Promise<string> => ipcRenderer.invoke('mcp:regenerateToken'),
    copy: (text: string): Promise<void> => ipcRenderer.invoke('mcp:copy', text),
    onStatus: (cb: (s: McpStatus) => void) => on('mcp:status', cb)
  },
  activity: {
    list: (): Promise<ActivityEntry[]> => ipcRenderer.invoke('activity:list'),
    clear: (): Promise<void> => ipcRenderer.invoke('activity:clear'),
    onAdded: (cb: (e: ActivityEntry) => void) => on('activity:added', cb)
  },
  approvals: {
    list: (): Promise<ApprovalRequest[]> => ipcRenderer.invoke('approvals:list'),
    resolve: (id: string, approved: boolean): Promise<boolean> => ipcRenderer.invoke('approvals:resolve', id, approved),
    onChanged: (cb: (list: ApprovalRequest[]) => void) => on('approvals:changed', cb)
  },
  remote: {
    list: (id: string, path: string): Promise<{ baseDir: string; entries: RemoteEntry[] }> => ipcRenderer.invoke('remote:list', id, path),
    read: (id: string, path: string, maxBytes: number): Promise<{ size: number; binary: boolean; text: string }> =>
      ipcRenderer.invoke('remote:read', id, path, maxBytes),
    mkdir: (id: string, path: string): Promise<void> => ipcRenderer.invoke('remote:mkdir', id, path),
    rename: (id: string, from: string, to: string): Promise<void> => ipcRenderer.invoke('remote:rename', id, from, to),
    delete: (id: string, path: string, isDir: boolean): Promise<void> => ipcRenderer.invoke('remote:delete', id, path, isDir),
    download: (id: string, remotePath: string, suggestedName: string): Promise<string | null> =>
      ipcRenderer.invoke('remote:download', id, remotePath, suggestedName),
    upload: (id: string, remoteDir: string): Promise<string[]> => ipcRenderer.invoke('remote:upload', id, remoteDir),
    disconnect: (id: string): Promise<void> => ipcRenderer.invoke('remote:disconnect', id)
  },
  app: {
    reveal: (p: string): Promise<void> => ipcRenderer.invoke('app:reveal', p),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    version: (): Promise<string> => ipcRenderer.invoke('app:version')
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
