import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface McpHttpOptions {
  port: number
  token: () => string
  makeServer: () => McpServer
  onError?: (err: Error) => void
}

const HOST = '127.0.0.1'
const PATH = '/mcp'

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!m) return false
  const a = Buffer.from(m[1])
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Local-only Streamable HTTP endpoint. Stateless: every POST gets a fresh transport + McpServer,
 * which keeps the surface small and avoids session bookkeeping. Responses are plain JSON so a
 * dependency-free stdio bridge can proxy them.
 */
export class McpHttpServer {
  private server: Server | null = null
  private port = 0

  constructor(private readonly opts: McpHttpOptions) {}

  get url(): string {
    return `http://${HOST}:${this.port}${PATH}`
  }

  get running(): boolean {
    return this.server !== null
  }

  async start(port: number): Promise<void> {
    await this.stop()
    this.port = port
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, HOST, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (err) => this.opts.onError?.(err))
    this.server = server
  }

  async stop(): Promise<void> {
    const s = this.server
    if (!s) return
    this.server = null
    await new Promise<void>((resolve) => {
      s.closeAllConnections?.()
      s.close(() => resolve())
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${HOST}`)
      if (url.pathname === '/health') return json(res, 200, { ok: true, name: 'ftp-man' })
      if (url.pathname !== PATH) return json(res, 404, { error: 'not found' })
      if (!tokenMatches(req.headers.authorization, this.opts.token())) {
        res.setHeader('www-authenticate', 'Bearer')
        return json(res, 401, { error: 'unauthorized' })
      }
      if (req.method !== 'POST') {
        // Stateless mode: no server-initiated stream and no session to delete.
        res.setHeader('allow', 'POST')
        return json(res, 405, { error: 'method not allowed' })
      }
      const raw = await readBody(req)
      let body: unknown
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        return json(res, 400, { error: 'invalid JSON' })
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [HOST, 'localhost', `${HOST}:${this.port}`, `localhost:${this.port}`]
      })
      const mcp = this.opts.makeServer()
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      this.opts.onError?.(err as Error)
      if (!res.headersSent) json(res, 500, { error: (err as Error).message })
      else res.end()
    }
  }
}
