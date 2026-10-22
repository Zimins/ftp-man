import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { RemoteEntry } from '@shared/types'
import { api, type ServerPublic } from '../api'
import { useT } from '../i18n'

interface DirState {
  entries: RemoteEntry[] | null
  loading: boolean
  error?: string
  expanded: boolean
}
interface Row {
  entry: RemoteEntry
  depth: number
}
interface Preview {
  path: string
  loading: boolean
  size?: number
  binary?: boolean
  text?: string
  error?: string
}
interface Menu {
  x: number
  y: number
  entry: RemoteEntry | null
}
interface NamePrompt {
  title: string
  initial: string
  submit: (name: string) => Promise<void>
}

const PREVIEW_MAX = 512 * 1024
type SortKey = 'name' | 'size' | 'modifiedAt'

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
function fmtDate(iso: string | undefined, precision: 'minute' | 'day' | undefined, locale: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const dayOnly = precision === 'day'
  return d.toLocaleString(locale, {
    year: sameYear && !dayOnly ? undefined : '2-digit',
    month: 'numeric',
    day: 'numeric',
    ...(dayOnly ? {} : { hour: '2-digit', minute: '2-digit' })
  })
}
function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}
const EXT_COLORS: Record<string, string> = {
  php: '#8892bf', html: '#e34c26', htm: '#e34c26', css: '#264de4', js: '#e5c100', ts: '#3178c6', json: '#8a8a8a',
  png: '#3fa34d', jpg: '#3fa34d', jpeg: '#3fa34d', gif: '#3fa34d', svg: '#3fa34d', webp: '#3fa34d', ico: '#3fa34d',
  zip: '#b06a2c', gz: '#b06a2c', tar: '#b06a2c', rar: '#b06a2c', sql: '#c25d8e', md: '#4c8ecb', txt: '#8a8a8a',
  log: '#8a8a8a', xml: '#f0a04b', yml: '#f0a04b', yaml: '#f0a04b', sh: '#4c8ecb', htaccess: '#b06a2c', pdf: '#d0342c'
}
function extOf(name: string): string {
  const base = name.startsWith('.') ? name.slice(1) : name
  const i = base.lastIndexOf('.')
  return i < 0 ? (name.startsWith('.') ? base : '') : base.slice(i + 1).toLowerCase()
}
const TEXT_EXT = new Set(['php', 'html', 'htm', 'css', 'js', 'ts', 'json', 'md', 'txt', 'log', 'xml', 'yml', 'yaml', 'sh', 'htaccess', 'sql', 'csv', 'ini', 'conf', 'env', 'py', 'rb', 'tsx', 'jsx', 'vue', 'svg'])

function FolderIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg className="fi fi-folder" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.4 0 .8.16 1.06.44L8.3 3.5H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12v-8.5z" fill="currentColor" opacity={open ? 0.55 : 0.85} />
      {open && <path d="M2.5 6.5h12l-1.2 6a1.2 1.2 0 0 1-1.18 1H3.9a1.2 1.2 0 0 1-1.18-1l-.22-6z" fill="currentColor" />}
    </svg>
  )
}
function FileIcon({ name }: { name: string }): ReactElement {
  const color = EXT_COLORS[extOf(name)] ?? 'currentColor'
  return (
    <svg className="fi fi-file" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M4 1.5h5.2L13 5.3V13a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13V3A1.5 1.5 0 0 1 4.5 1.5z" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.7" />
      <path d="M9 1.5v4h4" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.7" />
      <rect x="5" y="9" width="6" height="1.6" rx="0.8" fill={color} />
      <rect x="5" y="11.5" width="4" height="1.6" rx="0.8" fill={color} opacity="0.7" />
    </svg>
  )
}
function Chevron({ open, hidden }: { open: boolean; hidden?: boolean }): ReactElement {
  return (
    <svg className={`chev ${open ? 'open' : ''} ${hidden ? 'hidden-chev' : ''}`} viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FileBrowser({ server, onNotify }: { server: ServerPublic; onNotify: (m: string) => void }): ReactElement {
  const { t, locale } = useT()
  const [baseDir, setBaseDir] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [connErr, setConnErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [showHidden, setShowHidden] = useState(true)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const [menu, setMenu] = useState<Menu | null>(null)
  const [prompt, setPrompt] = useState<NamePrompt | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const patchDir = useCallback((path: string, patch: Partial<DirState>) => {
    setDirs((prev) => {
      const cur: DirState = prev[path] ?? { entries: null, loading: false, expanded: false }
      return { ...prev, [path]: { ...cur, ...patch } }
    })
  }, [])

  const loadDir = useCallback(
    async (path: string, expand = true): Promise<void> => {
      patchDir(path, { loading: true, error: undefined, expanded: expand })
      try {
        const r = await api.remote.list(server.id, path)
        setConnErr(null)
        if (baseDir === null) setBaseDir(r.baseDir)
        patchDir(path, { entries: r.entries, loading: false })
      } catch (err) {
        const msg = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        patchDir(path, { loading: false, error: msg })
        if (/\[(connect|auth)\]/.test(msg) || /Connect failed|Login failed|Authentication failed/.test(msg)) setConnErr(msg)
      }
    },
    [server.id, baseDir, patchDir]
  )

  // Initial connect: list "" resolves to the server base dir.
  useEffect(() => {
    let cancelled = false
    setDirs({})
    setBaseDir(null)
    setRoot(null)
    setSelected(null)
    setPreview(null)
    setConnErr(null)
    void (async () => {
      try {
        const r = await api.remote.list(server.id, '')
        if (cancelled) return
        setBaseDir(r.baseDir)
        setRoot(r.baseDir)
        setDirs({ [r.baseDir]: { entries: r.entries, loading: false, expanded: true } })
      } catch (err) {
        if (cancelled) return
        setConnErr((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [server.id])

  const toggle = (e: RemoteEntry): void => {
    if (e.type !== 'dir') return
    const st = dirs[e.path]
    if (!st || st.entries === null) void loadDir(e.path, true)
    else patchDir(e.path, { expanded: !st.expanded })
  }

  const sortEntries = useCallback(
    (list: RemoteEntry[]): RemoteEntry[] => {
      const q = filter.trim().toLowerCase()
      const dirFactor = sort.asc ? 1 : -1
      return [...list]
        .filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
        .sort((a, b) => {
          if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 * dirFactor : 1 * dirFactor
          let c = 0
          if (sort.key === 'size') c = a.size - b.size
          else if (sort.key === 'modifiedAt') c = (a.modifiedAt ?? '').localeCompare(b.modifiedAt ?? '')
          if (c === 0) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          return sort.asc ? c : -c
        })
    },
    [filter, showHidden, sort]
  )

  const rows = useMemo((): Row[] => {
    if (!root) return []
    const out: Row[] = []
    const walk = (dir: string, depth: number): void => {
      const st = dirs[dir]
      if (!st?.entries) return
      for (const e of sortEntries(st.entries)) {
        out.push({ entry: e, depth })
        if (e.type === 'dir' && dirs[e.path]?.expanded) walk(e.path, depth + 1)
      }
    }
    walk(root, 0)
    return out
  }, [root, dirs, sortEntries])

  const selectedEntry = useMemo(() => rows.find((r) => r.entry.path === selected)?.entry ?? null, [rows, selected])

  // Text preview for the selected file.
  useEffect(() => {
    if (!selectedEntry || selectedEntry.type !== 'file') {
      setPreview(null)
      return
    }
    const e = selectedEntry
    if (e.size > PREVIEW_MAX) {
      setPreview({ path: e.path, loading: false, size: e.size, error: t.browser.previewLimit(fmtSize(PREVIEW_MAX)) })
      return
    }
    if (!TEXT_EXT.has(extOf(e.name)) && extOf(e.name) !== '') {
      setPreview({ path: e.path, loading: false, size: e.size, binary: true })
      return
    }
    let cancelled = false
    setPreview({ path: e.path, loading: true })
    void api.remote
      .read(server.id, e.path, PREVIEW_MAX)
      .then((r) => !cancelled && setPreview({ path: e.path, loading: false, ...r }))
      .catch((err) => !cancelled && setPreview({ path: e.path, loading: false, error: (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
    return () => {
      cancelled = true
    }
  }, [selectedEntry, server.id])

  const targetDir = (): string => {
    if (selectedEntry?.type === 'dir') return selectedEntry.path
    if (selectedEntry) return parentOf(selectedEntry.path)
    return root ?? '/'
  }

  const run = async (label: string, fn: () => Promise<void>, refresh: string[]): Promise<void> => {
    setBusy(label)
    try {
      await fn()
      for (const d of new Set(refresh)) if (dirs[d]) await loadDir(d, dirs[d].expanded)
    } catch (err) {
      onNotify((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
    }
  }

  const actions = {
    refresh: (): void => {
      const d = selectedEntry?.type === 'dir' ? selectedEntry.path : root
      if (d) void loadDir(d, true)
    },
    newFolder: (): void => {
      const dir = targetDir()
      setPrompt({
        title: t.browser.newFolderIn(dir),
        initial: '',
        submit: (name) => run('mkdir', () => api.remote.mkdir(server.id, joinPath(dir, name)), [dir])
      })
    },
    rename: (e: RemoteEntry): void =>
      setPrompt({
        title: t.browser.renameTitle,
        initial: e.name,
        submit: (name) => run('rename', () => api.remote.rename(server.id, e.path, joinPath(parentOf(e.path), name)), [parentOf(e.path)])
      }),
    remove: (e: RemoteEntry): void => {
      if (!window.confirm(t.browser.confirmDelete(e.type === 'dir', e.name))) return
      void run('delete', () => api.remote.delete(server.id, e.path, e.type === 'dir'), [parentOf(e.path)]).then(() => {
        if (selected === e.path) setSelected(null)
      })
    },
    download: (e: RemoteEntry): void => {
      void run(
        'download',
        async () => {
          const p = await api.remote.download(server.id, e.path, e.name)
          if (p) onNotify(t.toast.downloaded(p))
        },
        []
      )
    },
    upload: (): void => {
      const dir = targetDir()
      void run(
        'upload',
        async () => {
          const up = await api.remote.upload(server.id, dir)
          if (up.length) onNotify(t.toast.uploaded(up.length, dir))
        },
        [dir]
      )
    },
    disconnect: (): void => {
      void api.remote.disconnect(server.id)
      setDirs({})
      setRoot(null)
      setBaseDir(null)
      setSelected(null)
      setConnErr(t.browser.disconnected)
    }
  }

  const onKey = (ev: React.KeyboardEvent): void => {
    if (rows.length === 0) return
    const idx = rows.findIndex((r) => r.entry.path === selected)
    const sel = (i: number): void => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))]
      setSelected(r.entry.path)
      listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(r.entry.path)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        sel(idx + 1)
        break
      case 'ArrowUp':
        ev.preventDefault()
        sel(idx - 1)
        break
      case 'ArrowRight':
        if (selectedEntry?.type === 'dir' && !dirs[selectedEntry.path]?.expanded) toggle(selectedEntry)
        break
      case 'ArrowLeft':
        if (selectedEntry?.type === 'dir' && dirs[selectedEntry.path]?.expanded) patchDir(selectedEntry.path, { expanded: false })
        else if (selectedEntry) {
          const p = parentOf(selectedEntry.path)
          if (rows.some((r) => r.entry.path === p)) setSelected(p)
        }
        break
      case 'Enter':
        if (selectedEntry) toggle(selectedEntry)
        break
      case 'Backspace':
      case 'Delete':
        if (selectedEntry && (ev.metaKey || ev.key === 'Delete')) actions.remove(selectedEntry)
        break
    }
  }

  const crumbs = useMemo(() => {
    if (!root) return []
    const parts = root.split('/').filter(Boolean)
    const out: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    let cur = ''
    for (const p of parts) {
      cur += '/' + p
      out.push({ label: p, path: cur })
    }
    return out
  }, [root])

  const goTo = (path: string): void => {
    setRoot(path)
    setSelected(null)
    if (!dirs[path]?.entries) void loadDir(path, true)
    else patchDir(path, { expanded: true })
  }

  const sortBtn = (key: SortKey, label: string): ReactElement => (
    <button className={`col-head ${sort.key === key ? 'active' : ''}`} onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}>
      {label}
      {sort.key === key && <span className="sort-arrow">{sort.asc ? '▲' : '▼'}</span>}
    </button>
  )

  const rootState = root ? dirs[root] : undefined
  const count = rootState?.entries?.length ?? 0

  return (
    <div className="browser" onClick={() => menu && setMenu(null)}>
      <div className="pathbar">
        <button className="icon-btn" title={t.browser.home} onClick={() => baseDir && goTo(baseDir)} disabled={!baseDir || root === baseDir}>
          ⌂
        </button>
        <button className="icon-btn" title={t.browser.up} onClick={() => root && root !== '/' && goTo(parentOf(root))} disabled={!root || root === '/'}>
          ↑
        </button>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb-wrap">
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className={`crumb ${c.path === root ? 'current' : ''}`} onClick={() => goTo(c.path)}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <input className="filter" type="search" placeholder={t.browser.filter} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon-btn" title={t.browser.refresh} onClick={actions.refresh} disabled={!root}>
          ↻
        </button>
      </div>

      <div className="toolbar">
        <button onClick={actions.upload} disabled={!root || busy !== null}>
          {t.browser.upload}
        </button>
        <button onClick={actions.newFolder} disabled={!root || busy !== null}>
          {t.browser.newFolder}
        </button>
        <button onClick={() => selectedEntry && actions.download(selectedEntry)} disabled={!selectedEntry || selectedEntry.type === 'dir' || busy !== null}>
          {t.browser.download}
        </button>
        <button onClick={() => selectedEntry && actions.rename(selectedEntry)} disabled={!selectedEntry || busy !== null}>
          {t.browser.rename}
        </button>
        <button className="danger" onClick={() => selectedEntry && actions.remove(selectedEntry)} disabled={!selectedEntry || busy !== null}>
          {t.browser.delete}
        </button>
        <span className="spacer" />
        <label className="check small">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> {t.browser.hidden}
        </label>
        <button onClick={actions.disconnect} disabled={!root}>
          {t.browser.disconnect}
        </button>
      </div>

      <div className={`browser-body ${preview ? 'with-preview' : ''}`}>
        <div className="tree" tabIndex={0} onKeyDown={onKey} ref={listRef} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry: null }) }}>
          <div className="tree-head">
            {sortBtn('name', t.browser.colName)}
            {sortBtn('size', t.browser.colSize)}
            {sortBtn('modifiedAt', t.browser.colDate)}
            <span className="col-head">{t.browser.colPerm}</span>
          </div>
          {connErr && (
            <div className="tree-msg bad">
              <div>{connErr}</div>
              <button onClick={() => { setConnErr(null); void loadDir(root ?? '', true) }}>{t.browser.reconnect}</button>
            </div>
          )}
          {!connErr && !root && <div className="tree-msg muted">{t.browser.connecting}</div>}
          {rootState?.error && <div className="tree-msg bad">{rootState.error}</div>}
          {root && rootState?.entries && rows.length === 0 && <div className="tree-msg muted">{filter ? t.browser.noMatch : t.browser.emptyDir}</div>}
          {rows.map(({ entry: e, depth }) => {
            const st = e.type === 'dir' ? dirs[e.path] : undefined
            return (
              <div
                key={e.path}
                data-path={e.path}
                className={`row ${selected === e.path ? 'selected' : ''} ${e.name.startsWith('.') ? 'hidden-file' : ''}`}
                style={{ paddingLeft: 8 + depth * 18 }}
                onClick={(ev) => { ev.stopPropagation(); setSelected(e.path); setMenu(null) }}
                onDoubleClick={() => toggle(e)}
                onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSelected(e.path); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }) }}
              >
                <span className="cell name">
                  <span className="chev-wrap" onClick={(ev) => { ev.stopPropagation(); toggle(e) }}>
                    <Chevron open={!!st?.expanded} hidden={e.type !== 'dir'} />
                  </span>
                  {e.type === 'dir' ? <FolderIcon open={!!st?.expanded} /> : <FileIcon name={e.name} />}
                  <span className="fname" title={e.path}>{e.name}</span>
                  {e.type === 'link' && <span className="muted small"> → link</span>}
                  {st?.loading && <span className="spinner" />}
                  {st?.error && <span className="bad small" title={st.error}> !</span>}
                </span>
                <span className="cell size">{e.type === 'dir' ? '' : fmtSize(e.size)}</span>
                <span className="cell date">{fmtDate(e.modifiedAt, e.modifiedPrecision, locale)}</span>
                <span className="cell perm">{e.permissions ?? ''}</span>
              </div>
            )
          })}
        </div>

        {preview && (
          <div className="preview">
            <div className="preview-head">
              <span className="fname" title={preview.path}>{preview.path.split('/').pop()}</span>
              <span className="muted small">{preview.size !== undefined ? fmtSize(preview.size) : ''}</span>
              <span className="spacer" />
              <button className="icon-btn" title={t.browser.close} onClick={() => setSelected(null)}>×</button>
            </div>
            {preview.loading && <div className="tree-msg muted">{t.browser.loading}</div>}
            {preview.error && <div className="tree-msg bad">{preview.error}</div>}
            {preview.binary && <div className="tree-msg muted">{t.browser.binary}</div>}
            {preview.text !== undefined && !preview.binary && <pre className="preview-text">{preview.text}</pre>}
          </div>
        )}
      </div>

      <div className="statusbar">
        <span className={`dot ${root ? 'on' : 'off'}`} />
        <span>{root ? t.browser.connected(server.protocol.toUpperCase(), `${server.username}@${server.host}`) : t.browser.notConnected}</span>
        <span className="muted">· {t.browser.items(count)}{rows.length !== count ? t.browser.shown(rows.length) : ''}</span>
        {busy && <span className="muted">· {busy}…</span>}
        <span className="spacer" />
        {selectedEntry && <span className="muted mono">{selectedEntry.path}</span>}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.entry ? (
            <>
              {menu.entry.type === 'dir' && <button onClick={() => { toggle(menu.entry!); setMenu(null) }}>{dirs[menu.entry.path]?.expanded ? t.browser.collapse : t.browser.expand}</button>}
              {menu.entry.type === 'dir' && <button onClick={() => { goTo(menu.entry!.path); setMenu(null) }}>{t.browser.goHere}</button>}
              {menu.entry.type !== 'dir' && <button onClick={() => { actions.download(menu.entry!); setMenu(null) }}>{t.browser.download}</button>}
              <button onClick={() => { actions.rename(menu.entry!); setMenu(null) }}>{t.browser.rename}…</button>
              <button onClick={() => { void api.mcp.copy(menu.entry!.path); onNotify(t.toast.pathCopied); setMenu(null) }}>{t.browser.copyPath}</button>
              <hr />
              <button className="danger" onClick={() => { actions.remove(menu.entry!); setMenu(null) }}>{t.browser.delete}…</button>
            </>
          ) : (
            <>
              <button onClick={() => { actions.upload(); setMenu(null) }}>{t.browser.uploadHere}</button>
              <button onClick={() => { actions.newFolder(); setMenu(null) }}>{t.browser.newFolder}…</button>
              <button onClick={() => { actions.refresh(); setMenu(null) }}>{t.browser.refresh}</button>
            </>
          )}
        </div>
      )}

      {prompt && (
        <div className="modal-backdrop" onClick={() => setPrompt(null)}>
          <form
            className="modal small-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              const name = (new FormData(e.currentTarget).get('name') as string).trim()
              if (!name || name.includes('/')) return
              const p = prompt
              setPrompt(null)
              void p.submit(name)
            }}
          >
            <h3>{prompt.title}</h3>
            <input name="name" defaultValue={prompt.initial} autoFocus onFocus={(e) => e.target.select()} spellCheck={false} />
            <div className="form-actions">
              <button type="button" onClick={() => setPrompt(null)}>{t.browser.cancel}</button>
              <span className="spacer" />
              <button type="submit" className="primary">{t.browser.ok}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
