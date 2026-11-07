import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  WebContents,
  WebContentsView
} from 'electron'
import { isExternalUrl } from './external'
import { log } from './log'
import { approvedExternalProtocols, approveExternalProtocol } from './snowconfig'

interface BrowserView {
  view: WebContentsView
  owner: WebContents
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserState {
  id: number
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

const views = new Map<number, BrowserView>()
const destroyHooked = new WeakSet<WebContents>()

const maxPopupsPerView = 6
const popupCounts = new Map<number, number>()

function disposeBrowserFor(wcId: number): void {
  for (const [id, entry] of views) {
    if (entry.owner.id !== wcId) continue
    entry.view.webContents.close()
    views.delete(id)
  }
}

function withWc(id: number, fn: (wc: WebContents) => void): void {
  const wc = views.get(id)?.view.webContents
  if (wc) fn(wc)
}

function attachPopupHandlers(wc: WebContents, parent: BrowserWindow, id: number): void {
  wc.setWindowOpenHandler(({ url: target }) => {
    if (target !== '' && target !== 'about:blank' && !isExternalUrl(target)) {
      log('warn', 'browser', 'blocked popup (non-web url)', { id, url: target })
      return { action: 'deny' }
    }
    if ((popupCounts.get(id) ?? 0) >= maxPopupsPerView) {
      log('warn', 'browser', 'blocked popup (too many open)', { id, url: target })
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent,
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      }
    }
  })

  wc.on('did-create-window', (popup) => {
    popupCounts.set(id, (popupCounts.get(id) ?? 0) + 1)
    log('info', 'browser', 'popup opened', { id, url: popup.webContents.getURL() })
    popup.show()
    popup.focus()
    attachPopupHandlers(popup.webContents, popup, id)
    popup.once('closed', () => {
      const remaining = (popupCounts.get(id) ?? 1) - 1
      if (remaining > 0) popupCounts.set(id, remaining)
      else popupCounts.delete(id)
      log('info', 'browser', 'popup closed', { id })
    })
  })
}

const browserPartition = 'persist:browser'
const grantedPermissions = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'storage-access',
  'top-level-storage-access'
])
const refusedExternalProtocols = new Set([
  'file:',
  'javascript:',
  'data:',
  'vbscript:',
  'ms-msdt:',
  'search-ms:',
  'search:',
  'ms-officecmd:',
  'ms-appinstaller:',
  'ms-word:',
  'ms-excel:',
  'ms-powerpoint:',
  'ms-visio:',
  'ms-access:',
  'ms-project:',
  'ms-publisher:',
  'ms-its:',
  'its:',
  'mk:',
  'hcp:',
  'ms-cxh:',
  'ms-cxh-full:',
  'smb:',
  'ldap:',
  'jar:'
])
const loggedOnce = new Set<string>()
const pendingPrompts = new Map<string, Promise<boolean>>()

function logOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (loggedOnce.has(key)) return
  loggedOnce.add(key)
  log('warn', 'browser', message, data)
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}

function protocolOf(raw: string): string | null {
  try {
    return new URL(raw).protocol
  } catch {
    return null
  }
}

function windowFor(wc: WebContents): BrowserWindow | null {
  for (const entry of views.values()) {
    if (entry.view.webContents === wc) return BrowserWindow.fromWebContents(entry.owner)
  }
  return BrowserWindow.fromWebContents(wc)
}

async function promptExternal(
  wc: WebContents,
  externalURL: string,
  protocol: string,
  origin: string
): Promise<boolean> {
  const appName = app.getApplicationNameForProtocol(externalURL) || protocol.slice(0, -1)
  const options = {
    type: 'question' as const,
    message: `Open ${appName}?`,
    detail: `${origin} wants to open ${appName} on your computer.`,
    buttons: ['Open', `Always open ${protocol} links`, 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const parent = windowFor(wc)
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (response === 1) {
    const result = approveExternalProtocol(protocol)
    if (result.error)
      log('warn', 'browser', 'could not remember protocol', { protocol, error: result.error })
  }
  if (response !== 2) log('info', 'browser', 'opened external', { protocol, origin })
  return response !== 2
}

function approveExternal(
  wc: WebContents,
  externalURL: string,
  requestingUrl: string
): Promise<boolean> {
  const protocol = protocolOf(externalURL)
  if (!protocol || isExternalUrl(externalURL) || refusedExternalProtocols.has(protocol)) {
    return Promise.resolve(false)
  }
  if (approvedExternalProtocols().includes(protocol)) return Promise.resolve(true)
  const origin = originOf(requestingUrl)
  const key = `${wc.id} ${protocol}`
  const pending = pendingPrompts.get(key)
  if (pending) return pending
  const prompt = promptExternal(wc, externalURL, protocol, origin)
    .catch(() => false)
    .finally(() => pendingPrompts.delete(key))
  pendingPrompts.set(key, prompt)
  return prompt
}

function restrictPermissions(): void {
  const ses = session.fromPartition(browserPartition)
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const deny = (): void => {
      logOnce(`${permission} ${originOf(details.requestingUrl)}`, 'denied permission', {
        permission,
        url: details.requestingUrl
      })
      callback(false)
    }
    if (grantedPermissions.has(permission)) {
      callback(true)
      return
    }
    if (
      permission !== 'openExternal' ||
      !('externalURL' in details) ||
      !details.externalURL ||
      !details.isMainFrame
    ) {
      deny()
      return
    }
    void approveExternal(wc, details.externalURL, details.requestingUrl).then((granted) =>
      granted ? callback(true) : deny()
    )
  })
  ses.setPermissionCheckHandler((_wc, permission) => grantedPermissions.has(permission))
}

export function registerBrowserHandlers(): void {
  restrictPermissions()
  ipcMain.on('browser:create', (event, { id, url }: { id: number; url: string }) => {
    views.get(id)?.view.webContents.close()

    const owner = event.sender
    const win = BrowserWindow.fromWebContents(owner)
    if (!win) return

    const view = new WebContentsView({
      webPreferences: { sandbox: true, partition: browserPartition }
    })
    const wc = view.webContents

    win.contentView.addChildView(view)
    view.setVisible(false)

    log('info', 'browser', 'create', { id, url })

    const safeSend = (payload: unknown): void => {
      if (owner.isDestroyed()) return
      try {
        owner.send('browser:state', payload)
      } catch {
        return
      }
    }

    const pushState = (): void => {
      const state: BrowserState = {
        id,
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading()
      }
      safeSend(state)
    }

    attachPopupHandlers(wc, win, id)

    wc.on('did-navigate', pushState)
    wc.on('did-navigate-in-page', pushState)
    wc.on('page-title-updated', pushState)
    wc.on('did-start-loading', pushState)
    wc.on('did-stop-loading', pushState)

    wc.loadURL(url).catch((error) =>
      log('warn', 'browser', 'load failed', { id, url, error: String(error) })
    )

    views.set(id, { view, owner })

    if (!destroyHooked.has(owner)) {
      destroyHooked.add(owner)
      const wcId = owner.id
      owner.once('destroyed', () => disposeBrowserFor(wcId))
    }
  })

  ipcMain.on(
    'browser:setBounds',
    (_event, { id, bounds, visible }: { id: number; bounds: BrowserBounds; visible: boolean }) => {
      const entry = views.get(id)
      if (!entry) return
      entry.view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height)
      })
      entry.view.setVisible(visible)
    }
  )

  ipcMain.on('browser:navigate', (_event, { id, url }: { id: number; url: string }) => {
    withWc(id, (wc) => wc.loadURL(url).catch(() => undefined))
  })

  ipcMain.on('browser:goBack', (_event, { id }: { id: number }) => {
    withWc(id, (wc) => {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    })
  })

  ipcMain.on('browser:goForward', (_event, { id }: { id: number }) => {
    withWc(id, (wc) => {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    })
  })

  ipcMain.on('browser:reload', (_event, { id }: { id: number }) => {
    withWc(id, (wc) => wc.reload())
  })

  ipcMain.on('browser:stop', (_event, { id }: { id: number }) => {
    withWc(id, (wc) => wc.stop())
  })

  ipcMain.on('browser:destroy', (_event, { id }: { id: number }) => {
    const entry = views.get(id)
    if (!entry) return
    BrowserWindow.fromWebContents(entry.owner)?.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    views.delete(id)
    log('info', 'browser', 'destroy', { id })
  })
}

export function disposeAllBrowser(): void {
  for (const { view } of views.values()) {
    view.webContents.close()
  }
  views.clear()
}
