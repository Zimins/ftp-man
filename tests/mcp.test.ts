import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ServerStore } from '../src/main/store/servers'
import { createPlainCipher } from '../src/main/store/cipher'
import { ConnectionPool } from '../src/main/remote/pool'
import { RemoteError, resolveRemotePath, type RemoteClient } from '../src/main/remote/types'
import { ApprovalBroker } from '../src/main/approvals'
import { ActivityLog } from '../src/main/activity'
import { createMcpServer } from '../src/main/mcp/tools'
import { DEFAULT_SETTINGS } from '../src/main/store/settings'
import type { RemoteEntry, Settings } from '../src/shared/types'

/** In-memory fake remote filesystem, one per server. */
class FakeRemote implements RemoteClient {
  readonly baseDir = '/home/u'
  closed = false
  constructor(public files: Map<string, string>) {}
  private abs(p: string): string {
    return resolveRemotePath(this.baseDir, p)
  }
  async list(path: string): Promise<RemoteEntry[]> {
    const dir = this.abs(path)
    const out: RemoteEntry[] = []
    for (const [p, c] of this.files) {
      if (p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')) {
        out.push({ name: p.slice(dir.length + 1), path: p, type: 'file', size: c.length })
      }
    }
    return out
  }
  async stat(path: string): Promise<RemoteEntry | null> {
    const p = this.abs(path)
    const c = this.files.get(p)
    return c === undefined ? null : { name: p.split('/').pop()!, path: p, type: 'file', size: c.length }
  }
  async readFile(path: string): Promise<Buffer> {
    const c = this.files.get(this.abs(path))
    if (c === undefined) throw new RemoteError('no such file', 'not_found')
    return Buffer.from(c)
  }
  async writeFile(path: string, data: Buffer): Promise<void> {
    this.files.set(this.abs(path), data.toString('utf8'))
  }
  async download(): Promise<void> {}
  async upload(): Promise<void> {}
  async deleteFile(path: string): Promise<void> {
    this.files.delete(this.abs(path))
  }
  async deleteDir(): Promise<void> {}
  async mkdir(): Promise<void> {}
  async rename(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true
  }
}

async function harness(settingsPatch: Partial<Settings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ftpman-mcp-'))
  const store = new ServerStore(join(dir, 'servers.json'), createPlainCipher())
  await store.load()
  const a = await store.create({ name: 'A', host: 'a', protocol: 'sftp', username: 'u', password: 'pa', tags: ['grp'] })
  const b = await store.create({ name: 'B', host: 'b', protocol: 'ftp', username: 'u', password: 'pb', tags: ['grp'] })
  const c = await store.create({ name: 'C', host: 'c', protocol: 'ftp', username: 'u', password: 'pc', tags: [] })
  const remotes = new Map<string, FakeRemote>()
  const connects: string[] = []
  const pool = new ConnectionPool(async (server, creds) => {
    connects.push(server.id)
    if (server.host === 'c') throw new RemoteError('connection refused', 'connect')
    assert.equal(creds.password, 'p' + server.host, 'credentials resolved from store')
    let r = remotes.get(server.id)
    if (!r) {
      r = new FakeRemote(new Map([[`/home/u/config.txt`, `host=${server.host}`]]))
      remotes.set(server.id, r)
    }
    return r
  }, () => 60_000, () => settingsPatch.maxConnections ?? 6)
  const approvals = new ApprovalBroker(500)
  const activity = new ActivityLog(join(dir, 'activity.jsonl'))
  const settings: Settings = { ...DEFAULT_SETTINGS, approvalMode: 'none', ...settingsPatch }
  const server = createMcpServer({ store, settings: () => settings, pool, approvals, activity, version: 'test' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(ct)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    return { isError: r.isError === true, text, json: r.isError ? null : JSON.parse(text) }
  }
  return { store, pool, approvals, activity, settings, client, call, ids: { a: a.id, b: b.id, c: c.id }, connects, remotes }
}

test('list_servers never exposes credentials and supports tag filter', async () => {
  const h = await harness()
  const all = await h.call('list_servers', {})
  assert.equal(all.json.count, 3)
  assert.ok(!all.text.includes('"pa"') && !all.text.toLowerCase().includes('password'))
  const grp = await h.call('list_servers', { tag: 'grp' })
  assert.deepEqual(grp.json.servers.map((s: { name: string }) => s.name), ['A', 'B'])
  const tools = await h.client.listTools()
  assert.ok(tools.tools.some((t) => t.name === 'batch'))
})

test('read_file / write_file by server name, unknown server errors', async () => {
  const h = await harness()
  const r = await h.call('read_file', { server: 'A', path: 'config.txt' })
  assert.equal(r.json.content, 'host=a')
  const w = await h.call('write_file', { server: h.ids.a, path: 'new.txt', content: 'hello' })
  assert.equal(w.json.ok, true)
  assert.equal(h.remotes.get(h.ids.a)!.files.get('/home/u/new.txt'), 'hello')
  const bad = await h.call('read_file', { server: 'Nope', path: 'x' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /Unknown server/)
  assert.equal(h.activity.list()[0].tool, 'write_file')
})

test('batch runs sequentially, isolates per-server failures, reuses connections', async () => {
  const h = await harness()
  const r = await h.call('batch', { tag: 'grp', operation: { type: 'read_file', path: 'config.txt' } })
  assert.equal(r.json.succeeded, 2)
  assert.deepEqual(r.json.results.map((x: { result: { content: string } }) => x.result.content), ['host=a', 'host=b'])
  const r2 = await h.call('batch', { servers: ['A', 'B', 'C'], operation: { type: 'write_file', path: 'config.txt', content: 'x=1' } })
  assert.equal(r2.json.succeeded, 2)
  assert.equal(r2.json.failed, 1)
  const failed = r2.json.results.find((x: { ok: boolean }) => !x.ok)
  assert.equal(failed.server, 'C')
  assert.match(failed.error, /connection refused/)
  assert.equal(h.connects.filter((id) => id === h.ids.a).length, 1, 'pooled connection reused across calls')
  const stop = await h.call('batch', { servers: ['C', 'A'], operation: { type: 'test_connection' }, stop_on_error: true })
  assert.equal(stop.json.skipped, 1)
})

test('read-only mode blocks writes, approval mode gates and can deny', async () => {
  const ro = await harness({ readOnly: true })
  const w = await ro.call('write_file', { server: 'A', path: 'x', content: 'y' })
  assert.equal(w.isError, true)
  assert.match(w.text, /read-only/)
  const ok = await ro.call('list_files', { server: 'A' })
  assert.equal(ok.json.entries.length, 1)

  const ap = await harness({ approvalMode: 'writes' })
  const pending = new Promise<void>((resolve) => {
    const off = ap.approvals.onChange((list) => {
      if (list.length === 1) {
        off()
        assert.equal(list[0].tool, 'delete_path')
        ap.approvals.resolve(list[0].id, false)
        resolve()
      }
    })
  })
  const denied = await ap.call('delete_path', { server: 'A', path: 'config.txt' })
  await pending
  assert.equal(denied.isError, true)
  assert.match(denied.text, /denied/)
  assert.equal(ap.remotes.has(ap.ids.a), false, 'denied operation never connects')

  const approve = new Promise<void>((resolve) => {
    const off = ap.approvals.onChange((list) => {
      if (list.length === 1) {
        off()
        ap.approvals.resolve(list[0].id, true)
        resolve()
      }
    })
  })
  const okDel = await ap.call('delete_path', { server: 'A', path: 'config.txt' })
  await approve
  assert.equal(okDel.json.ok, true)
  assert.equal(ap.remotes.get(ap.ids.a)!.files.has('/home/u/config.txt'), false)
  const reads = await ap.call('read_file', { server: 'B', path: 'config.txt' })
  assert.equal(reads.json.content, 'host=b', 'reads do not need approval in writes mode')
})

test('deletes approval mode lets file changes through and only gates deletes', async () => {
  const h = await harness({ approvalMode: 'deletes' })
  const asked: string[] = []
  h.approvals.onChange((list) => {
    for (const req of list) {
      asked.push(req.tool)
      h.approvals.resolve(req.id, false)
    }
  })
  const w = await h.call('write_file', { server: 'A', path: 'new.txt', content: 'hi' })
  assert.equal(w.isError, false, w.text)
  const md = await h.call('make_directory', { server: 'A', path: 'dir' })
  assert.equal(md.isError, false, md.text)
  const mv = await h.call('rename_path', { server: 'A', from: 'new.txt', to: 'moved.txt' })
  assert.equal(mv.isError, false, mv.text)
  const bw = await h.call('batch', { tag: 'grp', operation: { type: 'write_file', path: 'b.txt', content: 'x' } })
  assert.equal(bw.json.succeeded, 2)
  assert.deepEqual(asked, [], 'no approval asked for writes')

  const del = await h.call('delete_path', { server: 'A', path: 'config.txt' })
  assert.match(del.text, /denied/)
  const bdel = await h.call('batch', { tag: 'grp', operation: { type: 'delete_path', path: 'config.txt' } })
  assert.match(bdel.text, /denied/)
  assert.deepEqual(asked, ['delete_path', 'batch'])
  assert.equal(h.remotes.get(h.ids.a)!.files.has('/home/u/config.txt'), true, 'denied delete kept the file')
})

test('pool evicts a connection after an error and reconnects', async () => {
  const h = await harness()
  await h.call('read_file', { server: 'A', path: 'config.txt' })
  const first = h.remotes.get(h.ids.a)!
  const missing = await h.call('read_file', { server: 'A', path: 'missing.txt' })
  assert.equal(missing.isError, true)
  assert.equal(first.closed, true, 'connection closed after error')
  assert.equal(h.connects.filter((id) => id === h.ids.a).length, 1, 'not_found is not retried')
  await h.call('read_file', { server: 'A', path: 'config.txt' })
  assert.equal(h.connects.filter((id) => id === h.ids.a).length, 2)
})

test('pool retries once on a dropped reused connection', async () => {
  const h = await harness()
  await h.call('read_file', { server: 'B', path: 'config.txt' })
  const remote = h.remotes.get(h.ids.b)!
  const origRead = remote.readFile.bind(remote)
  let dropped = false
  remote.readFile = async (p: string) => {
    if (!dropped) {
      dropped = true
      throw new RemoteError('ECONNRESET', 'remote')
    }
    return origRead(p)
  }
  const r = await h.call('read_file', { server: 'B', path: 'config.txt' })
  assert.equal(r.json.content, 'host=b', 'transparent reconnect + retry')
  assert.equal(h.connects.filter((id) => id === h.ids.b).length, 2)
  assert.equal(remote.closed, true, 'dropped connection was closed')
})

test('pool caps open connections and evicts the least recently used idle one', async () => {
  const h = await harness({ maxConnections: 1 })
  await h.call('read_file', { server: 'A', path: 'config.txt' })
  const a1 = h.remotes.get(h.ids.a)!
  await h.call('read_file', { server: 'B', path: 'config.txt' })
  assert.equal(a1.closed, true, 'A was evicted to make room for B')
  assert.equal(h.pool.activeCount(), 1)
  await h.call('read_file', { server: 'A', path: 'config.txt' })
  assert.equal(h.connects.filter((id) => id === h.ids.a).length, 2, 'A reconnected on demand')
})
