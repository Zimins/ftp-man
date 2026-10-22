import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ServerStore } from './store/servers'
import { SettingsStore } from './store/settings'
import { createElectronCipher } from './store/cipher'
import { ConnectionPool, defaultConnector } from './remote/pool'
import { ApprovalBroker } from './approvals'
import { ActivityLog } from './activity'
import { TokenFile } from './mcp/token'
import { McpHttpServer } from './mcp/http'
import { createMcpServer } from './mcp/tools'
import { registerIpc, registerRemoteIpc, type AppContext } from './ipc'
import { dataDir, files } from './paths'

declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : app.getVersion()

app.setPath('userData', dataDir())
app.setName('FTP Man')

let mainWindow: BrowserWindow | null = null
let quitting = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    // Keep serving MCP requests when the window is closed; Cmd+Q quits for real.
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

async function bootstrap(): Promise<void> {
  const cipher = await createElectronCipher()
  const store = new ServerStore(files.servers(), cipher)
  const settings = new SettingsStore(files.settings())
  const activity = new ActivityLog(files.activity())
  const token = new TokenFile(files.token())
  await Promise.all([store.load(), settings.load(), activity.load(), token.ensure()])

  // Scripted bulk setup: `FTP Man --import-csv=/path/servers.csv` (also handy for tests).
  const importArg = process.argv.find((a) => a.startsWith('--import-csv='))
  if (importArg) {
    const csvPath = importArg.slice('--import-csv='.length)
    const result = await store.importCsv(await readFile(csvPath, 'utf8'), (p) => readFile(p, 'utf8'))
    console.log(`[import-csv] created ${result.created}, updated ${result.updated}, skipped ${result.skipped}, errors ${result.errors.length}`)
    for (const e of result.errors) console.error(`[import-csv] ${e}`)
  }

  const pool = new ConnectionPool(
    defaultConnector,
    () => settings.get().idleTimeoutSec * 1000,
    () => settings.get().maxConnections
  )
  const approvals = new ApprovalBroker()

  let lastError: string | undefined
  const http = new McpHttpServer({
    port: settings.get().mcpPort,
    token: () => token.get(),
    makeServer: () =>
      createMcpServer({
        store,
        settings: () => settings.get(),
        pool,
        approvals,
        activity,
        version: APP_VERSION
      }),
    onError: (err) => {
      lastError = err.message
      console.error('[mcp]', err)
    }
  })

  const bridgePath = app.isPackaged
    ? join(process.resourcesPath, 'bridge', 'ftp-man-mcp.mjs')
    : join(app.getAppPath(), 'bin', 'ftp-man-mcp.mjs')

  const ctx: AppContext = {
    store,
    settings,
    activity,
    approvals,
    pool,
    token,
    http,
    bridgePath,
    version: APP_VERSION,
    getWindow: () => mainWindow,
    mcpStatus: () => ({
      running: http.running,
      port: settings.get().mcpPort,
      url: http.url,
      tokenFile: token.path,
      bridgePath,
      error: lastError
    }),
    restartMcp: async () => {
      lastError = undefined
      await http.stop()
      if (settings.get().mcpEnabled) {
        try {
          await http.start(settings.get().mcpPort)
        } catch (err) {
          lastError = (err as Error).message
        }
      }
      mainWindow?.webContents.send('mcp:status', ctx.mcpStatus())
    }
  }
  registerIpc(ctx)
  registerRemoteIpc(ctx)

  await ctx.restartMcp()
  mainWindow = createWindow()

  approvals.onChange((list) => {
    if (list.length > 0 && mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show()
      if (!mainWindow.isFocused()) app.dock?.bounce('critical')
    }
  })

  app.on('activate', () => {
    if (mainWindow) mainWindow.show()
    else mainWindow = createWindow()
  })
  app.on('before-quit', () => {
    quitting = true
    approvals.resolveAll(false)
    void http.stop()
    void pool.closeAll()
  })
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error('Failed to start', err)
  app.quit()
})

app.on('window-all-closed', () => {
  /* keep running in the dock; MCP stays available */
})
