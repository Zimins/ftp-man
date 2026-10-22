import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerStore } from '../src/main/store/servers'
import { createPlainCipher } from '../src/main/store/cipher'
import { parseCsv, toCsv } from '../src/main/store/csv'
import { resolveRemotePath } from '../src/main/remote/types'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ftpman-'))

test('csv round trip handles quotes and newlines', () => {
  const rows = [
    ['name', 'host'],
    ['a "quoted", name', 'h1'],
    ['multi\nline', 'h2']
  ]
  assert.deepEqual(parseCsv(toCsv(rows)), rows)
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2']
  ])
})

test('store creates, encrypts secrets and never exposes them', async () => {
  const store = new ServerStore(join(tmp(), 'servers.json'), createPlainCipher())
  await store.load()
  const s = await store.create({ name: 'Alpha', host: 'a.example.com', protocol: 'sftp', username: 'u', password: 'p@ss', tags: ['prod', 'Prod', ' web '] })
  assert.equal(s.port, 22)
  assert.equal(s.hasPassword, true)
  assert.deepEqual(s.tags, ['prod', 'web'])
  assert.ok(!JSON.stringify(store.list()).includes('p@ss'))
  assert.equal(store.credentials(s.id).password, 'p@ss')

  // reload from disk
  const store2 = new ServerStore((store as unknown as { filePath: string }).filePath, createPlainCipher())
  await store2.load()
  assert.equal(store2.credentials(s.id).password, 'p@ss')
  assert.equal(store2.get(s.id)?.name, 'Alpha')
})

test('update keeps secrets unless provided, clears on empty string', async () => {
  const store = new ServerStore(join(tmp(), 'servers.json'), createPlainCipher())
  await store.load()
  const s = await store.create({ name: 'B', host: 'b', protocol: 'ftp', username: 'u', password: 'one' })
  await store.update(s.id, { host: 'b2' })
  assert.equal(store.credentials(s.id).password, 'one')
  await store.update(s.id, { password: '' })
  assert.equal(store.credentials(s.id).password, undefined)
  assert.equal(store.get(s.id)?.hasPassword, false)
  await store.update(s.id, { protocol: 'sftp' })
  assert.equal(store.get(s.id)?.port, 22, 'default port follows protocol change')
})

test('resolve by id or unique name, select by tag/query', async () => {
  const store = new ServerStore(join(tmp(), 'servers.json'), createPlainCipher())
  await store.load()
  const a = await store.create({ name: 'Site A', host: 'a', protocol: 'ftp', username: '', tags: ['client-x'] })
  await store.create({ name: 'Site B', host: 'b', protocol: 'ftp', username: '', tags: ['client-x', 'staging'] })
  await store.create({ name: 'Other', host: 'c', protocol: 'sftp', username: '', tags: [] })
  assert.equal(store.resolve(a.id)?.name, 'Site A')
  assert.equal(store.resolve('site a')?.id, a.id)
  assert.equal(store.resolve('nope'), undefined)
  assert.equal(store.select({ tag: 'CLIENT-X' }).length, 2)
  assert.equal(store.select({ tag: 'client-x', query: 'stag' }).length, 1)
  assert.equal(store.select({ ids: ['Site A', 'Other'] }).length, 2)
  assert.throws(() => store.select({ ids: ['missing'] }), /Unknown server/)
  assert.deepEqual(store.allTags(), ['client-x', 'staging'])
})

test('csv import creates and updates, export omits secrets', async () => {
  const store = new ServerStore(join(tmp(), 'servers.json'), createPlainCipher())
  await store.load()
  const csv = ['Name,Host,Port,Protocol,Username,Password,Tags,Notes', 'S1,s1.example.com,,sftp,root,secret1,"a;b",hello', 'S2,s2.example.com,2121,ftp,ftpuser,secret2,a,', ',missing-name,,,,,,'].join('\n')
  const r = await store.importCsv(csv)
  assert.deepEqual([r.created, r.updated, r.skipped, r.errors], [2, 0, 1, []])
  const s1 = store.resolve('S1')!
  assert.equal(s1.port, 22)
  assert.deepEqual(s1.tags, ['a', 'b'])
  assert.equal(store.credentials(s1.id).password, 'secret1')
  const r2 = await store.importCsv('name,host,password\nS1,new.example.com,\n')
  assert.equal(r2.updated, 1)
  assert.equal(store.resolve('S1')?.host, 'new.example.com')
  assert.equal(store.credentials(s1.id).password, 'secret1', 'empty password column keeps secret')
  const exported = store.exportCsv()
  assert.ok(!exported.includes('secret1'))
  assert.ok(exported.includes('S2,s2.example.com,2121,ftp,ftpuser,a'))
})

test('resolveRemotePath normalises relative and absolute paths', () => {
  assert.equal(resolveRemotePath('/home/u', ''), '/home/u')
  assert.equal(resolveRemotePath('/home/u', 'public_html/index.php'), '/home/u/public_html/index.php')
  assert.equal(resolveRemotePath('/home/u', '/var/www'), '/var/www')
  assert.equal(resolveRemotePath('/home/u', '../x/./y/../z'), '/home/x/z')
  assert.equal(resolveRemotePath('/', 'a'), '/a')
})
