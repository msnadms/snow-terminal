import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { openExternal } from './external'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerPtyHandlers, disposeAllPty } from './pty'
import { registerBrowserHandlers, disposeAllBrowser } from './browser'
import { registerGitHandlers, disposeGitWatchers } from './git'
import { registerWorkflowHandlers } from './workflow'
import { initRegistry, disposeRegistryWatcher } from './registry'
import { registerThemeHandlers, disposeThemeWatcher } from './theme'
import { registerSnowignoreHandlers, disposeSnowignoreWatcher } from './snowignore'
import { registerSnowconfigHandlers, disposeSnowconfigWatcher } from './snowconfig'
import { registerUsageHandlers, disposeUsageWatcher } from './usage'
import { initLogging, closeLogging, log, logPath, watchRenderer } from './log'
import { configDir } from './config'
import { startCli, registerCliHandlers } from './cli'

if (!startCli()) app.exit(0)

initLogging()

function createWindow(): void {
  // Create the browser window.
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

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
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

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('io.github.msnadms.snow')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Register pseudo-terminal (node-pty) IPC handlers.
  registerPtyHandlers()

  // Register embedded-browser (WebContentsView) IPC handlers.
  registerBrowserHandlers()

  // Load ~/.config/snow/.snowworkflows and watch it for edits. Before the git handlers, which
  // consult the registry to decide whether a branch switch parks its changes.
  initRegistry()

  // Register git info IPC handlers; each call carries the repo cwd.
  registerGitHandlers()

  // Register workflow IPC handlers.
  registerWorkflowHandlers()

  // Load ~/.config/snow/theme.json and watch it for edits.
  registerThemeHandlers()

  // Load ~/.config/snow/.snowignore and watch it for edits.
  registerSnowignoreHandlers()

  // Load ~/.config/snow/.snowconfig and watch it for edits.
  registerSnowconfigHandlers()

  // Watch ~/.claude/projects for Claude Code session logs to tally daily/weekly cost.
  registerUsageHandlers()

  // Resolve a folder passed on the command line into a preset; after the snowconfig
  // handlers, which seed the file this writes to.
  registerCliHandlers()

  log('info', 'app', 'ready', { log: logPath(), config: configDir() })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Ensure all PTY processes are terminated when the app quits.
app.on('will-quit', () => {
  disposeAllPty()
  disposeAllBrowser()
  disposeGitWatchers()
  disposeRegistryWatcher()
  disposeThemeWatcher()
  disposeSnowignoreWatcher()
  disposeSnowconfigWatcher()
  disposeUsageWatcher()
  closeLogging()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
