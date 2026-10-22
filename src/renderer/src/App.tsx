import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ActivityEntry, ApprovalRequest, McpStatus, Settings } from '@shared/types'
import { api, type ServerPublic } from './api'
import { ServerList } from './components/ServerList'
import { ServerForm } from './components/ServerForm'
import { ActivityView } from './components/ActivityView'
import { SettingsView } from './components/SettingsView'
import { ApprovalModal } from './components/ApprovalModal'
import { FileBrowser } from './components/FileBrowser'
import { DICTS, LangContext, resolveLang } from './i18n'

type Tab = 'servers' | 'activity' | 'settings'

export function App(): ReactElement {
  const [tab, setTab] = useState<Tab>('servers')
  const [servers, setServers] = useState<ServerPublic[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [detailTab, setDetailTab] = useState<'files' | 'info'>('files')
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [mcp, setMcp] = useState<McpStatus | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3500)
  }, [])

  useEffect(() => {
    void api.servers.list().then(setServers)
    void api.activity.list().then(setActivity)
    void api.approvals.list().then(setApprovals)
    void api.settings.get().then(setSettings)
    void api.mcp.status().then(setMcp)
    const offs = [
      api.servers.onChanged(setServers),
      api.activity.onAdded((e) => setActivity((prev) => [e, ...prev].slice(0, 500))),
      api.approvals.onChanged(setApprovals),
      api.settings.onChanged(setSettings),
      api.mcp.onStatus(setMcp)
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const selected = useMemo(() => servers.find((s) => s.id === selectedId) ?? null, [servers, selectedId])
  const lang = resolveLang(settings?.language ?? 'system')
  const t = DICTS[lang]

  const startCreate = (): void => {
    setSelectedId(null)
    setCreating(true)
    setTab('servers')
  }

  return (
    <LangContext.Provider value={{ lang, t }}>
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-drag" />
        <nav className="tabs">
          <button className={tab === 'servers' ? 'active' : ''} onClick={() => setTab('servers')}>
            {t.tabs.servers} <span className="count">{servers.length}</span>
          </button>
          <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>
            {t.tabs.activity}
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            {t.tabs.settings}
          </button>
        </nav>
        <div className="mcp-pill" title={mcp?.error ?? mcp?.url ?? ''}>
          <span className={`dot ${mcp?.running ? 'on' : 'off'}`} />
          MCP {mcp?.running ? `:${mcp.port}` : settings?.mcpEnabled === false ? t.mcp.off : t.mcp.error}
        </div>
      </header>

      {tab === 'servers' && (
        <div className="split">
          <ServerList
            servers={servers}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id)
              setCreating(false)
            }}
            onCreate={startCreate}
            onImport={async () => {
              const r = await api.servers.importCsv()
              if (r) notify(t.toast.imported({ created: r.created, updated: r.updated, skipped: r.skipped, errors: r.errors.length }))
              if (r?.errors.length) console.warn(r.errors)
            }}
            onExport={async () => {
              const p = await api.servers.exportCsv()
              if (p) notify(t.toast.exported(p))
            }}
          />
          <main className={`detail ${selected && !creating && detailTab === 'files' ? 'detail-files' : ''}`}>
            {selected && !creating && (
              <div className="detail-head">
                <div className="detail-title">
                  <h2>{selected.name}</h2>
                  <span className="muted small">
                    {selected.protocol.toUpperCase()} · {selected.username ? `${selected.username}@` : ''}
                    {selected.host}
                    {selected.rootPath ? ` · ${selected.rootPath}` : ''}
                  </span>
                </div>
                <div className="segmented">
                  <button className={detailTab === 'files' ? 'active' : ''} onClick={() => setDetailTab('files')}>
                    {t.detail.files}
                  </button>
                  <button className={detailTab === 'info' ? 'active' : ''} onClick={() => setDetailTab('info')}>
                    {t.detail.info}
                  </button>
                </div>
              </div>
            )}
            {selected && !creating && detailTab === 'files' ? (
              <FileBrowser key={selected.id} server={selected} onNotify={notify} />
            ) : creating || selected ? (
              <ServerForm
                key={selected?.id ?? 'new'}
                server={selected}
                allTags={[...new Set(servers.flatMap((s) => s.tags))].sort()}
                onSaved={(s) => {
                  setSelectedId(s.id)
                  setCreating(false)
                  notify(t.toast.saved)
                }}
                onDeleted={() => {
                  setSelectedId(null)
                  setCreating(false)
                  notify(t.toast.deleted)
                }}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <div className="empty">
                <h2>{t.empty.title}</h2>
                <p>{t.empty.body}</p>
                <div className="row">
                  <button className="primary" onClick={startCreate}>
                    {t.empty.add}
                  </button>
                  <button onClick={() => setTab('settings')}>{t.empty.connect}</button>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {tab === 'activity' && (
        <ActivityView
          entries={activity}
          onClear={async () => {
            await api.activity.clear()
            setActivity([])
          }}
        />
      )}

      {tab === 'settings' && settings && (
        <SettingsView settings={settings} mcp={mcp} onNotify={notify} onSettings={setSettings} />
      )}

      {approvals.length > 0 && <ApprovalModal requests={approvals} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
    </LangContext.Provider>
  )
}
