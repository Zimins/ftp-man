#!/usr/bin/env node
/**
 * stdio ⇄ HTTP bridge for FTP Man.
 *
 * Lets MCP clients that only speak stdio (Claude Desktop, some IDEs) talk to the FTP Man app,
 * which serves MCP over local HTTP. No dependencies: it forwards newline-delimited JSON-RPC
 * messages from stdin as POSTs and writes the JSON (or SSE-wrapped) responses to stdout.
 *
 * Config (all optional):
 *   FTP_MAN_URL    full endpoint, default http://127.0.0.1:<port from settings.json>/mcp
 *   FTP_MAN_TOKEN  bearer token, default read from <data dir>/mcp-token
 *   FTP_MAN_DIR    data dir, default ~/Library/Application Support/ftp-man
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const dataDir = process.env.FTP_MAN_DIR || join(homedir(), 'Library', 'Application Support', 'ftp-man')

function readPort() {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    if (Number.isInteger(s.mcpPort)) return s.mcpPort
  } catch {
    /* defaults */
  }
  return 7391
}

function readToken() {
  if (process.env.FTP_MAN_TOKEN) return process.env.FTP_MAN_TOKEN
  try {
    return readFileSync(join(dataDir, 'mcp-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

const url = process.env.FTP_MAN_URL || `http://127.0.0.1:${readPort()}/mcp`
let token = readToken()

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const errorFor = (id, message, code = -32000) => ({ jsonrpc: '2.0', id, error: { code, message } })

async function forward(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const id = Array.isArray(msg) ? undefined : msg.id
  if (!token) token = readToken()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`
      },
      body: line
    })
  } catch (err) {
    if (id !== undefined) out(errorFor(id, `FTP Man app is not reachable at ${url}. Is the app running? (${err.message})`))
    return
  }
  if (res.status === 401) {
    token = readToken()
    if (id !== undefined) out(errorFor(id, 'FTP Man rejected the token. Regenerate it in the app and restart this client.'))
    return
  }
  if (res.status === 202 || res.status === 204) return
  const ctype = res.headers.get('content-type') || ''
  const body = await res.text()
  if (!res.ok) {
    if (id !== undefined) out(errorFor(id, `FTP Man returned HTTP ${res.status}: ${body.slice(0, 300)}`))
    return
  }
  if (ctype.includes('text/event-stream')) {
    for (const block of body.split(/\n\n+/)) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n')
      if (!data) continue
      try {
        out(JSON.parse(data))
      } catch {
        /* ignore non-JSON events */
      }
    }
    return
  }
  if (body.trim()) {
    try {
      out(JSON.parse(body))
    } catch {
      if (id !== undefined) out(errorFor(id, 'Invalid JSON from FTP Man'))
    }
  }
}

const inflight = new Set()
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  const p = forward(line).catch(() => undefined)
  inflight.add(p)
  void p.finally(() => inflight.delete(p))
})
rl.on('close', () => {
  // Let in-flight requests finish before exiting so piped one-shot usage works too.
  void Promise.allSettled([...inflight]).then(() => process.exit(0))
})
