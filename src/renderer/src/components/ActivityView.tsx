import type { ReactElement } from 'react'
import type { ActivityEntry } from '@shared/types'
import { useT } from '../i18n'

interface Props {
  entries: ActivityEntry[]
  onClear: () => void
}

export function ActivityView({ entries, onClear }: Props): ReactElement {
  const { t, locale } = useT()
  const fmt = (ts: string): string =>
    new Date(ts).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <main className="page">
      <div className="page-head">
        <h2>{t.activity.title}</h2>
        <p className="muted">{t.activity.subtitle}</p>
        <span className="spacer" />
        <button onClick={onClear} disabled={entries.length === 0}>
          {t.activity.clear}
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="empty">
          <p>{t.activity.empty}</p>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t.activity.time}</th>
              <th>{t.activity.tool}</th>
              <th>{t.activity.server}</th>
              <th>{t.activity.summary}</th>
              <th>{t.activity.result}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className={e.ok ? '' : 'row-bad'}>
                <td className="nowrap muted">{fmt(e.ts)}</td>
                <td>
                  <code>{e.tool}</code>
                </td>
                <td className="nowrap">{e.serverName ?? ''}</td>
                <td className="wrap">{e.summary}</td>
                <td className="nowrap">
                  {e.ok ? <span className="ok">{t.activity.ok}</span> : <span className="bad" title={e.error}>{t.activity.fail}</span>}{' '}
                  <span className="muted">{e.durationMs} ms</span>
                  {!e.ok && e.error && <div className="muted small wrap">{e.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
