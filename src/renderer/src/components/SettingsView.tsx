import { useEffect, useState, type ReactElement } from 'react'
import type { ApprovalMode, McpStatus, Settings } from '@shared/types'
import { api } from '../api'
import { useT } from '../i18n'

interface Props {
  settings: Settings
  mcp: McpStatus | null
  onNotify: (msg: string) => void
  onSettings: (s: Settings) => void
}

export function SettingsView({ settings, mcp, onNotify, onSettings }: Props): ReactElement {
  const { t } = useT()
  const [port, setPort] = useState(String(settings.mcpPort))
  const [maxKb, setMaxKb] = useState(String(Math.round(settings.maxTextBytes / 1024)))
  const [idle, setIdle] = useState(String(settings.idleTimeoutSec))
  const [maxConn, setMaxConn] = useState(String(settings.maxConnections))
  const [token, setToken] = useState<string>('')
  const [showToken, setShowToken] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void api.mcp.token().then(setToken)
    void api.app.version().then(setVersion)
  }, [])

  const update = async (patch: Partial<Settings>): Promise<void> => {
    try {
      onSettings(await api.settings.set(patch))
    } catch (err) {
      onNotify((err as Error).message)
    }
  }

  const url = mcp?.url ?? `http://127.0.0.1:${settings.mcpPort}/mcp`
  const claudeCodeCmd = `claude mcp add --transport http ftp-man ${url} --header "Authorization: Bearer ${token}"`
  const desktopConfig = JSON.stringify(
    { mcpServers: { 'ftp-man': { command: 'node', args: [mcp?.bridgePath ?? '<bridge path>'] } } },
    null,
    2
  )
  const copy = (text: string, label: string): void => {
    void api.mcp.copy(text).then(() => onNotify(t.toast.copied(label)))
  }

  return (
    <main className="page settings">
      <section>
        <h2>{t.settings.mcpTitle}</h2>
        <div className={`alert ${mcp?.running ? 'ok' : 'bad'}`}>
          {mcp?.running ? t.settings.running(mcp.url) : mcp?.error ? t.settings.error(mcp.error) : t.settings.stopped}
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.mcpEnabled} onChange={(e) => void update({ mcpEnabled: e.target.checked })} />
          {t.settings.enable}
        </label>
        <div className="row">
          <label>
            {t.settings.port}
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" style={{ width: 100 }} />
          </label>
          <button onClick={() => void update({ mcpPort: Number(port) })} disabled={Number(port) === settings.mcpPort}>
            {t.settings.applyPort}
          </button>
        </div>
      </section>

      <section>
        <h2>{t.settings.agentTitle}</h2>
        <p className="muted">{t.settings.agentBody}</p>
        <div className="row">
          <code className="token">{showToken ? token : '•'.repeat(24)}</code>
          <button onClick={() => setShowToken((v) => !v)}>{showToken ? t.settings.hide : t.settings.show}</button>
          <button onClick={() => copy(token, t.settings.token)}>{t.settings.copyToken}</button>
          <button
            className="danger"
            onClick={async () => {
              if (!window.confirm(t.settings.confirmRegenerate)) return
              setToken(await api.mcp.regenerateToken())
              onNotify(t.toast.tokenRegenerated)
            }}
          >
            {t.settings.regenerate}
          </button>
        </div>
        <h3>{t.settings.claudeCode}</h3>
        <pre className="snippet">{claudeCodeCmd}</pre>
        <div className="row">
          <button onClick={() => copy(claudeCodeCmd, t.settings.claudeCodeCommand)}>{t.settings.copyCommand}</button>
        </div>
        <h3>{t.settings.desktopTitle}</h3>
        <p className="muted small">{t.settings.desktopBody}</p>
        <pre className="snippet">{desktopConfig}</pre>
        <div className="row">
          <button onClick={() => copy(desktopConfig, t.settings.desktopConfig)}>{t.settings.copyConfig}</button>
          <button onClick={() => mcp && void api.app.reveal(mcp.bridgePath)}>{t.settings.revealBridge}</button>
        </div>
      </section>

      <section>
        <h2>{t.settings.safetyTitle}</h2>
        <label>
          {t.settings.approvalMode}
          <select value={settings.approvalMode} onChange={(e) => void update({ approvalMode: e.target.value as ApprovalMode })}>
            <option value="none">{t.settings.approvalNone}</option>
            <option value="deletes">{t.settings.approvalDeletes}</option>
            <option value="writes">{t.settings.approvalWrites}</option>
            <option value="all">{t.settings.approvalAll}</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.readOnly} onChange={(e) => void update({ readOnly: e.target.checked })} />
          {t.settings.readOnly}
        </label>
        <p className="muted small">{t.settings.hostLimitHint}</p>
        <div className="row">
          <label>
            {t.settings.maxText}
            <input value={maxKb} onChange={(e) => setMaxKb(e.target.value)} inputMode="numeric" style={{ width: 100 }} />
          </label>
          <label>
            {t.settings.idle}
            <input value={idle} onChange={(e) => setIdle(e.target.value)} inputMode="numeric" style={{ width: 100 }} />
          </label>
          <label>
            {t.settings.maxConn}
            <input value={maxConn} onChange={(e) => setMaxConn(e.target.value)} inputMode="numeric" style={{ width: 100 }} />
          </label>
          <button onClick={() => void update({ maxTextBytes: Number(maxKb) * 1024, idleTimeoutSec: Number(idle), maxConnections: Number(maxConn) })}>
            {t.settings.apply}
          </button>
        </div>
      </section>

      <section>
        <h2>{t.settings.languageTitle}</h2>
        <label>
          {t.settings.language}
          <select value={settings.language} onChange={(e) => void update({ language: e.target.value as Settings['language'] })} style={{ width: 220 }}>
            <option value="system">{t.settings.langSystem}</option>
            <option value="ko">{t.settings.langKo}</option>
            <option value="en">{t.settings.langEn}</option>
          </select>
        </label>
      </section>

      <section>
        <h2>{t.settings.storageTitle}</h2>
        <p className="muted small">
          {t.settings.storageServers} <code>{mcp?.tokenFile.replace(/mcp-token$/, 'servers.json')}</code>
          <br />
          {t.settings.storageToken} <code>{mcp?.tokenFile}</code>
        </p>
        <p className="muted small">FTP Man {version}</p>
      </section>
    </main>
  )
}
