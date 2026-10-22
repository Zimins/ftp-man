import type { ReactElement } from 'react'
import type { ApprovalRequest } from '@shared/types'
import { api } from '../api'
import { useT } from '../i18n'

export function ApprovalModal({ requests }: { requests: ApprovalRequest[] }): ReactElement {
  const { t, locale } = useT()
  const req = requests[0]
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{t.approval.title}</h3>
        <p className="muted small">
          {requests.length > 1 ? t.approval.pending(requests.length) : ''}
          {t.approval.autoDeny(new Date(req.expiresAt).toLocaleTimeString(locale))}
        </p>
        <dl className="kv">
          <dt>{t.approval.tool}</dt>
          <dd>
            <code>{req.tool}</code>
          </dd>
          <dt>{t.approval.action}</dt>
          <dd className="wrap">{req.summary}</dd>
          <dt>{t.approval.targets}</dt>
          <dd className="wrap">
            {req.serverNames.length <= 8
              ? req.serverNames.join(', ')
              : `${req.serverNames.slice(0, 8).join(', ')}${t.approval.more(req.serverNames.length - 8)}`}
          </dd>
        </dl>
        <div className="form-actions">
          <button className="danger" onClick={() => void api.approvals.resolve(req.id, false)}>
            {t.approval.deny}
          </button>
          <span className="spacer" />
          <button className="primary" onClick={() => void api.approvals.resolve(req.id, true)} autoFocus>
            {t.approval.approve}
          </button>
        </div>
      </div>
    </div>
  )
}
