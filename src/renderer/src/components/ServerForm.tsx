import { useState, type ReactElement } from 'react'
import type { AuthType, Protocol } from '@shared/types'
import { api, type ServerPublic } from '../api'
import { useT } from '../i18n'

interface Props {
  server: ServerPublic | null
  allTags: string[]
  onSaved: (s: ServerPublic) => void
  onDeleted: () => void
  onCancel: () => void
}

const DEFAULT_PORT: Record<Protocol, number> = { ftp: 21, ftps: 21, sftp: 22 }
const stripIpc = (m: string): string => m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function ServerForm({ server, allTags, onSaved, onDeleted, onCancel }: Props): ReactElement {
  const { t } = useT()
  const [name, setName] = useState(server?.name ?? '')
  const [host, setHost] = useState(server?.host ?? '')
  const [protocol, setProtocol] = useState<Protocol>(server?.protocol ?? 'sftp')
  const [port, setPort] = useState(String(server?.port ?? DEFAULT_PORT[server?.protocol ?? 'sftp']))
  const [username, setUsername] = useState(server?.username ?? '')
  const [authType, setAuthType] = useState<AuthType>(server?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [tags, setTags] = useState(server?.tags.join(', ') ?? '')
  const [rootPath, setRootPath] = useState(server?.rootPath ?? '')
  const [notes, setNotes] = useState(server?.notes ?? '')
  const [insecureTls, setInsecureTls] = useState(server?.insecureTls ?? false)
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(
    server?.lastTestOk !== undefined ? { ok: server.lastTestOk, message: server.lastTestMessage ?? '' } : null
  )

  const changeProtocol = (p: Protocol): void => {
    if (port === String(DEFAULT_PORT[protocol])) setPort(String(DEFAULT_PORT[p]))
    setProtocol(p)
    if (p !== 'sftp') setAuthType('password')
  }

  const buildInput = () => ({
    name,
    host,
    port: Number(port) || DEFAULT_PORT[protocol],
    protocol,
    username,
    authType: protocol === 'sftp' ? authType : 'password',
    tags: tags.split(',').map((x) => x.trim()).filter(Boolean),
    rootPath,
    notes,
    insecureTls,
    ...(clearPassword ? { password: '' } : password ? { password } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(passphrase ? { passphrase } : {})
  })

  const save = async (): Promise<ServerPublic | null> => {
    setBusy('save')
    setError(null)
    try {
      const saved = server ? await api.servers.update(server.id, buildInput()) : await api.servers.create(buildInput())
      setPassword('')
      setPrivateKey('')
      setPassphrase('')
      setClearPassword(false)
      onSaved(saved)
      return saved
    } catch (err) {
      setError(stripIpc((err as Error).message))
      return null
    } finally {
      setBusy(null)
    }
  }

  const test = async (): Promise<void> => {
    const saved = await save()
    if (!saved) return
    setBusy('test')
    setTestMsg(null)
    try {
      setTestMsg(await api.servers.test(saved.id))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (!server) return
    if (!window.confirm(t.form.confirmDelete(server.name))) return
    setBusy('delete')
    try {
      await api.servers.remove(server.id)
      onDeleted()
    } finally {
      setBusy(null)
    }
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="form-head">
        <h2>{server ? server.name : t.form.newServer}</h2>
        {server && <code className="muted small" title={t.form.idHint}>{server.id}</code>}
      </div>

      <div className="grid">
        <label>
          {t.form.name}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.form.namePlaceholder} required autoFocus />
        </label>
        <label>
          {t.form.protocol}
          <select value={protocol} onChange={(e) => changeProtocol(e.target.value as Protocol)}>
            <option value="sftp">SFTP (SSH)</option>
            <option value="ftps">FTPS (FTP over TLS)</option>
            <option value="ftp">{t.form.ftpPlain}</option>
          </select>
        </label>
        <label className="span2">
          {t.form.host}
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ftp.example.com" required />
        </label>
        <label>
          {t.form.port}
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          {t.form.username}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
        {protocol === 'sftp' && (
          <label>
            {t.form.authType}
            <select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
              <option value="password">{t.form.authPassword}</option>
              <option value="key">{t.form.authKey}</option>
            </select>
          </label>
        )}
        {(protocol !== 'sftp' || authType === 'password') && (
          <label className={protocol === 'sftp' ? '' : 'span2'}>
            {t.form.password}
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setClearPassword(false)
              }}
              placeholder={server?.hasPassword ? t.form.passwordStored : ''}
              autoComplete="new-password"
            />
            {server?.hasPassword && (
              <span className="inline-check">
                <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> {t.form.clearPassword}
              </span>
            )}
          </label>
        )}
        {protocol === 'sftp' && authType === 'key' && (
          <>
            <label className="span2">
              {t.form.privateKey} {server?.hasPrivateKey && !privateKey && <span className="muted">{t.form.keyStored}</span>}
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                rows={4}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                spellCheck={false}
              />
              <button
                type="button"
                className="small-btn"
                onClick={async () => {
                  const k = await api.servers.pickKeyFile()
                  if (k) setPrivateKey(k)
                }}
              >
                {t.form.loadFromFile}
              </button>
            </label>
            <label>
              {t.form.passphrase}
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}
        <label className="span2">
          {t.form.tags} <span className="muted">{t.form.tagsHint}</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} list="tag-options" placeholder="client-a, prod, wordpress" />
          <datalist id="tag-options">
            {allTags.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </label>
        <label>
          {t.form.rootPath} <span className="muted">{t.form.optional}</span>
          <input value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder="/var/www/html" />
        </label>
        {protocol === 'ftps' && (
          <label className="check">
            <input type="checkbox" checked={insecureTls} onChange={(e) => setInsecureTls(e.target.checked)} />
            {t.form.insecureTls}
          </label>
        )}
        <label className="span2">
          {t.form.notes}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </label>
      </div>

      {error && <div className="alert bad">{error}</div>}
      {testMsg && <div className={`alert ${testMsg.ok ? 'ok' : 'bad'}`}>{testMsg.message}</div>}

      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy !== null}>
          {busy === 'save' ? t.form.saving : t.form.save}
        </button>
        <button type="button" onClick={() => void test()} disabled={busy !== null}>
          {busy === 'test' ? t.form.testing : t.form.testAfterSave}
        </button>
        <span className="spacer" />
        {server ? (
          <button type="button" className="danger" onClick={() => void remove()} disabled={busy !== null}>
            {t.form.delete}
          </button>
        ) : (
          <button type="button" onClick={onCancel}>
            {t.form.cancel}
          </button>
        )}
      </div>
    </form>
  )
}
