import { useMemo, useState, type ReactElement } from 'react'
import type { ServerPublic } from '../api'
import { useT } from '../i18n'

interface Props {
  servers: ServerPublic[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onImport: () => void
  onExport: () => void
}

export function ServerList({ servers, selectedId, onSelect, onCreate, onImport, onExport }: Props): ReactElement {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const tags = useMemo(() => [...new Set(servers.flatMap((s) => s.tags))].sort(), [servers])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return servers.filter(
      (s) =>
        (!tag || s.tags.includes(tag)) &&
        (!q || s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q) || s.tags.some((x) => x.toLowerCase().includes(q)))
    )
  }, [servers, query, tag])

  return (
    <aside className="sidebar">
      <div className="sidebar-tools">
        <input type="search" placeholder={t.list.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon" title={t.list.add} onClick={onCreate}>
          +
        </button>
      </div>
      {tags.length > 0 && (
        <div className="chips">
          <button className={`chip ${tag === null ? 'active' : ''}`} onClick={() => setTag(null)}>
            {t.list.all}
          </button>
          {tags.map((x) => (
            <button key={x} className={`chip ${tag === x ? 'active' : ''}`} onClick={() => setTag(tag === x ? null : x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      <ul className="server-list">
        {filtered.map((s) => (
          <li key={s.id} className={s.id === selectedId ? 'selected' : ''} onClick={() => onSelect(s.id)}>
            <span
              className={`status ${s.lastTestOk === true ? 'ok' : s.lastTestOk === false ? 'bad' : ''}`}
              title={s.lastTestMessage ?? t.list.notTested}
            />
            <div className="server-main">
              <div className="server-name">{s.name}</div>
              <div className="server-host">
                {s.username ? `${s.username}@` : ''}
                {s.host}
                {s.port !== (s.protocol === 'sftp' ? 22 : 21) ? `:${s.port}` : ''}
              </div>
            </div>
            <span className={`proto ${s.protocol}`}>{s.protocol.toUpperCase()}</span>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted">{t.list.none}</li>}
      </ul>
      <div className="sidebar-footer">
        <button onClick={onImport}>{t.list.importCsv}</button>
        <button onClick={onExport}>{t.list.exportCsv}</button>
      </div>
    </aside>
  )
}
