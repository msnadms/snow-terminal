import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { openExternal } from './external'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerPtyHandlers, disposeAllPty } from './pty'
import { registerBrowserHandlers, disposeAllBrowser } from './browser'
import { registerLocalhostHandlers } from './localhost'
import { registerFileHandlers, disposeFileWatchers } from './files'
import { registerGitHandlers, disposeGitWatchers } from './git'
import { registerWorkflowHandlers } from './workflow'
import { initRegistry, disposeRegistryWatcher } from './registry'
import { registerThemeHandlers, disposeThemeWatcher } from './theme'
import { registerSnowignoreHandlers, disposeSnowignoreWatcher } from './snowignore'
import { registerSnowconfigHandlers, disposeSnowconfigWatcher } from './snowconfig'
import { registerAgentHandlers, disposeAgentWatcher } from './agents'
import { refreshHooks, registerHooksHandlers } from './hooks'
import { initLogging, closeLogging, log, logPath, watchRenderer } from './log'
import { configDir } from './config'
import { startCli, registerCliHandlers } from './cli'

if (!startCli()) app.exit(0)

initLogging()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  watchRenderer(mainWindow.webContents)

  mainWindow.on('ready-to-show', () => {
    log('info', 'window', 'shown', { id: mainWindow.id })
    mainWindow.show()
  })

  mainWindow.on('closed', () => log('info', 'window', 'closed'))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternal(details.url).catch((error) =>
      log('warn', 'window', 'blocked window.open', { url: details.url, error: String(error) })
    )
    return { action: 'deny' }
  })

  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const appOrigin = devUrl ? new URL(devUrl).origin : null

  const isInternal = (url: string): boolean => {
    if (!appOrigin) return url.startsWith('file://') && url.endsWith('/renderer/index.html')
    try {
      return new URL(url).origin === appOrigin
    } catch {
      return false
    }
  }

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return
    event.preventDefault()
    log('warn', 'window', 'blocked navigation', { url })
    openExternal(url).catch(() => undefined)
  })

  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  registerPtyHandlers()
  registerBrowserHandlers()
  registerLocalhostHandlers()
  registerFileHandlers()
  initRegistry()
  registerGitHandlers()
  registerWorkflowHandlers()
  registerThemeHandlers()
  registerSnowignoreHandlers()
  registerSnowconfigHandlers()
  registerAgentHandlers()
  refreshHooks()
  registerHooksHandlers()
  registerCliHandlers()

  log('info', 'app', 'ready', { log: logPath(), config: configDir() })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  disposeAllPty()
  disposeAllBrowser()
  disposeGitWatchers()
  disposeFileWatchers()
  disposeRegistryWatcher()
  disposeThemeWatcher()
  disposeSnowignoreWatcher()
  disposeSnowconfigWatcher()
  disposeAgentWatcher()
  closeLogging()
})
