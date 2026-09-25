declare const process: { env: { PLAYWRITER_PORT: string } }
// Injected by vite at build time from playwriter/package.json version.
// CLI/MCP compare this against their own version to warn when the extension is outdated.
declare const __PLAYWRITER_VERSION__: string
// Bundled automation builds should not burn a tab on the welcome page, especially
// in headless/VPS flows where the extension is installed only to attach to the relay.
declare const __PLAYWRITER_OPEN_WELCOME_PAGE__: boolean

import { createStore } from 'zustand/vanilla'
import type { ExtensionState, ConnectionState, TabState, TabInfo } from './types'
import type { CDPEvent, Protocol } from 'playwriter/src/cdp-types'
import type { ExtensionCommandMessage, ExtensionResponseMessage } from 'playwriter/src/protocol'
import { handleGhostBrowserCommand, type GhostBrowserCommandParams } from 'playwriter/src/ghost-browser'

const RELAY_HOST = '127.0.0.1'
const RELAY_PORT = Number(process.env.PLAYWRITER_PORT) || 19988
// Desktop overlay's summon listener (relay port + 1). When the user toggles a
// tab to the connected state we ping this so the overlay launches immediately,
// independent of relay/CDP state syncing.
const OVERLAY_SUMMON_PORT = RELAY_PORT + 1

function summonOverlay(tab?: chrome.tabs.Tab): void {
  // Fire-and-forget; the desktop app may not be running, which is fine. Include
  // the connected tab's URL/title so the desktop can decide the permission card
  // without depending on relay state (which is empty when no agent is driving).
  void fetch(`http://${RELAY_HOST}:${OVERLAY_SUMMON_PORT}/summon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: tab?.url ?? null, title: tab?.title ?? null }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {})
}

// Keep the desktop overlay's input placeholder ("What's next in the <tab> tab?")
// live: the relay's cached tab state only refreshes on window-focus changes, so
// push the focused window's active tab whenever it changes (in-Chrome tab
// switches, title/url updates, window focus). Pushed directly (no setTimeout —
// MV3 can suspend the worker before a short timer fires) and de-duped by
// url+title; the desktop only applies it while the overlay targets a browser.
//
// IMPORTANT: prefer the tab object carried by the event (onActivated's tabId,
// onUpdated's tab) over re-querying `{active:true}`. A query inside onActivated
// can resolve against stale state and return the tab being *left*, which — with
// the de-dup — makes the placeholder lag one switch behind.
let lastActiveTabPushKey = ''
async function pushTab(tab: chrome.tabs.Tab | null | undefined): Promise<void> {
  if (!tab) {
    return
  }
  const key = `${tab.url ?? ''}\u0000${tab.title ?? ''}`
  if (key === lastActiveTabPushKey) {
    return
  }
  lastActiveTabPushKey = key
  await fetch(`http://${RELAY_HOST}:${OVERLAY_SUMMON_PORT}/active-tab`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: tab.url ?? null, title: tab.title ?? null }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {})
}
async function pushActiveTabNow(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    await pushTab(tab)
  } catch {
    // best-effort only
  }
}

type NavigatorWithUaData = Navigator & {
  userAgentData?: {
    brands: Array<{ brand: string; version: string }>
  }
}

type ExtensionConnectionInfo = {
  browser: string
  installId: string
}

type TabShareSource = 'user' | 'agent-created' | 'auto-created'

const EXTENSION_DB_NAME = 'interpreter-extension'
const EXTENSION_DB_VERSION = 1
const EXTENSION_DB_STORE = 'metadata'
const EXTENSION_INSTALL_ID_KEY = 'relay-install-id'
const MAX_PAGE_ELEMENT_INVENTORY_COUNT = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function detectBrowserName(): Promise<string> {
  if ((chrome as unknown as { ghostPublicAPI?: unknown }).ghostPublicAPI) {
    return 'Ghost'
  }

  const navigatorWithUaData = navigator as NavigatorWithUaData
  const brands = navigatorWithUaData.userAgentData?.brands
  if (brands && brands.length > 0) {
    const brandNames = brands.map((brand) => {
      return brand.brand.trim().toLowerCase()
    })

    if (brandNames.some((brand) => brand === 'brave')) return 'Brave'
    if (brandNames.some((brand) => brand === 'microsoft edge')) return 'Edge'
    if (brandNames.some((brand) => brand === 'opera')) return 'Opera'
    if (brandNames.some((brand) => brand === 'vivaldi')) return 'Vivaldi'
    if (brandNames.some((brand) => brand === 'google chrome')) return 'Chrome'
    if (brandNames.some((brand) => brand === 'chromium')) return 'Chromium'
  }

  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('edg/')) return 'Edge'
  if (ua.includes('opr/')) return 'Opera'
  if (ua.includes('vivaldi')) return 'Vivaldi'
  if (ua.includes('brave')) return 'Brave'
  if (ua.includes('chrome')) return 'Chrome'
  return 'Chromium'
}

let connectionInfoPromise: Promise<ExtensionConnectionInfo> | null = null
const tabSessionScope = (() => {
  const values = new Uint32Array(2)
  crypto.getRandomValues(values)
  return Array.from(values)
    .map((value) => {
      return value.toString(36)
    })
    .join('')
})()

function openExtensionDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(EXTENSION_DB_NAME, EXTENSION_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(EXTENSION_DB_STORE)) {
        db.createObjectStore(EXTENSION_DB_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open extension database'))
  })
}

async function readExtensionMetadata(key: string): Promise<string | undefined> {
  const db = await openExtensionDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(EXTENSION_DB_STORE, 'readonly')
      const store = tx.objectStore(EXTENSION_DB_STORE)
      const request = store.get(key)
      request.onsuccess = () => {
        const value = request.result
        resolve(typeof value === 'string' ? value : undefined)
      }
      request.onerror = () => reject(request.error ?? new Error(`Failed to read metadata key: ${key}`))
    })
  } finally {
    db.close()
  }
}

async function writeExtensionMetadata(key: string, value: string): Promise<void> {
  const db = await openExtensionDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(EXTENSION_DB_STORE, 'readwrite')
      const store = tx.objectStore(EXTENSION_DB_STORE)
      const request = store.put(value, key)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error(`Failed to write metadata key: ${key}`))
    })
  } finally {
    db.close()
  }
}

async function getPersistentInstallId(): Promise<string> {
  const existing = await readExtensionMetadata(EXTENSION_INSTALL_ID_KEY)
  if (existing) {
    return existing
  }

  const installId = crypto.randomUUID()
  await writeExtensionMetadata(EXTENSION_INSTALL_ID_KEY, installId)
  return installId
}

async function getExtensionConnectionInfo(): Promise<ExtensionConnectionInfo> {
  if (connectionInfoPromise) {
    return connectionInfoPromise
  }

  connectionInfoPromise = (async () => {
    const browser = await detectBrowserName()
    const installId = await getPersistentInstallId()
    return {
      browser,
      installId,
    }
  })()

  return connectionInfoPromise
}

let childSessions: Map<string, { tabId: number; targetId?: string }> = new Map()
let nextSessionId = 1
// Cache Target.setAutoAttach params so existing and future tabs enable OOPIF target events.
// This ensures Playwright can build the iframe frame tree when connecting over CDP.
let autoAttachParams: Protocol.Target.SetAutoAttachRequest | null = null

class ConnectionManager {
  ws: WebSocket | null = null
  private connectionPromise: Promise<void> | null = null
  preserveTabsOnDetach = false

  async ensureConnection(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    if (store.getState().connectionState === 'extension-replaced') {
      throw new Error('Another Bolt Chrome Extension is already connected')
    }

    // Reuse in-progress connection attempt - prevents races between user clicks and maintain loop
    if (this.connectionPromise) {
      return this.connectionPromise
    }

    // Wrap connect() with a global timeout to ensure it never hangs forever.
    // This protects against edge cases where individual timeouts don't fire
    // (e.g., DNS resolution hangs, AbortSignal doesn't work, etc.)
    const GLOBAL_TIMEOUT_MS = 15000
    this.connectionPromise = Promise.race([
      this.connect(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Connection timeout (global)'))
        }, GLOBAL_TIMEOUT_MS)
      }),
    ])

    try {
      await this.connectionPromise
    } finally {
      this.connectionPromise = null
    }
  }

  private async connect(): Promise<void> {
    logger.debug(`Waiting for server at http://${RELAY_HOST}:${RELAY_PORT}...`)

    // Retry for up to 5 seconds with 1s intervals, then give up (maintain loop will retry later)
    // Using fewer attempts since maintainLoop retries every 3 seconds anyway
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await fetch(`http://${RELAY_HOST}:${RELAY_PORT}`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
        logger.debug('Server is available')
        break
      } catch {
        if (attempt === maxAttempts - 1) {
          throw new Error('Server not available')
        }
        logger.debug(`Server not available, retrying... (attempt ${attempt + 1}/${maxAttempts})`)
        await sleep(1000)
      }
    }

    const connectionInfo = await getExtensionConnectionInfo()
    const relayUrl = new URL(`ws://${RELAY_HOST}:${RELAY_PORT}/extension`)
    if (connectionInfo.browser) {
      relayUrl.searchParams.set('browser', connectionInfo.browser)
    }
    if (connectionInfo.installId) {
      relayUrl.searchParams.set('installId', connectionInfo.installId)
    }
    if (typeof __PLAYWRITER_VERSION__ !== 'undefined') {
      relayUrl.searchParams.set('v', __PLAYWRITER_VERSION__)
    }
    logger.debug('Creating WebSocket connection to:', relayUrl)
    const socket = new WebSocket(relayUrl.toString())

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        logger.debug('WebSocket connection TIMEOUT after 5 seconds')
        try {
          socket.close()
        } catch {}
        reject(new Error('Connection timeout'))
      }, 5000)

      socket.onopen = () => {
        if (settled) return
        settled = true
        logger.debug('WebSocket connected')
        clearTimeout(timeout)
        resolve()
      }

      socket.onerror = (error) => {
        logger.debug('WebSocket error during connection:', error)
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error('WebSocket connection failed'))
      }

      socket.onclose = (event) => {
        logger.debug('WebSocket closed during connection:', { code: event.code, reason: event.reason })
        if (settled) return
        settled = true
        clearTimeout(timeout)
        // Normalize 4002 rejection to consistent error message for callers to detect
        if (event.code === 4002 || event.reason === 'Extension Already In Use') {
          reject(new Error('Extension Already In Use'))
        } else {
          reject(new Error(`WebSocket closed: ${event.reason || event.code}`))
        }
      }
    })

    this.ws = socket

    this.ws.onmessage = async (event: MessageEvent) => {
      let message: any
      try {
        message = JSON.parse(event.data)
      } catch (error: any) {
        logger.debug('Error parsing message:', error)
        sendMessage({ error: { code: -32700, message: `Error parsing message: ${error.message}` } })
        return
      }

      // Handle ping from server - respond with pong to keep service worker alive
      if (message.method === 'ping') {
        sendMessage({ method: 'pong' })
        return
      }

      // Handle createInitialTab - create a new tab when Playwright connects and no tabs exist
      // We use skipAttachedEvent: true because the relay's Target.setAutoAttach handler will send
      // Target.attachedToTarget for all targets in connectedTargets. If we also sent it here,
      // Playwright would receive a duplicate.
      //
      // This differs from the normal flow (user clicks extension icon) where:
      // 1. Extension attaches and sends Target.attachedToTarget to existing Playwright clients
      // 2. New Playwright clients that connect later get targets via Target.setAutoAttach
      //
      // But with createInitialTab, the SAME client that triggered the create is waiting for
      // Target.setAutoAttach - so we'd send the event twice to the same client.
      if (message.method === 'createInitialTab') {
        try {
          logger.debug('Creating initial tab for Playwright client')
          const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
          if (tab.id) {
            setTabConnecting(tab.id)
            const { targetInfo, sessionId } = await attachTab(tab.id, {
              skipAttachedEvent: true,
              shareSource: 'auto-created',
            })
            logger.debug('Initial tab created and connected:', tab.id, 'sessionId:', sessionId)
            sendMessage({
              id: message.id,
              result: {
                success: true,
                tabId: tab.id,
                sessionId,
                targetInfo,
              },
            })
          } else {
            throw new Error('Failed to create tab - no tab ID returned')
          }
        } catch (error: any) {
          logger.debug('Failed to create initial tab:', error)
          sendMessage({ id: message.id, error: error.message })
        }
        return
      }

      // Handle Ghost Browser API commands
      // This allows calling chrome.ghostPublicAPI, chrome.ghostProxies, chrome.projects
      // from the playwriter executor sandbox when running in Ghost Browser
      if (message.method === 'ghost-browser') {
        const params = message.params as GhostBrowserCommandParams
        const result = await handleGhostBrowserCommand(params, chrome)
        if (!result.success) {
          logger.error('Ghost Browser API error:', result.error)
        }
        // Auto-connect tabs created via ghostPublicAPI.openTab so they appear in context.pages()
        if (result.success && params.namespace === 'ghostPublicAPI' && params.method === 'openTab') {
          const tabId = result.result as number
          if (tabId) {
            logger.debug('Auto-connecting Ghost Browser tab:', tabId)
            setTabConnecting(tabId)
            await sleep(100)
            await attachTab(tabId)
          }
        }
        sendMessage({ id: message.id, result })
        return
      }

      if (message.method === 'arrangeWindowForTarget') {
        sendMessage({
          id: message.id,
          result: await arrangeWindowForTarget(message.params ?? {}),
        })
        return
      }

      if (message.method === 'activateBrowserTab') {
        sendMessage({
          id: message.id,
          result: await activateBrowserTab(message.params ?? {}),
        })
        return
      }

      if (message.method === 'claimBrowserTab') {
        sendMessage({
          id: message.id,
          result: await claimBrowserTab(message.params ?? {}),
        })
        return
      }

      if (message.method === 'listBrowserTabs') {
        sendMessage({
          id: message.id,
          result: await listBrowserTabs(),
        })
        return
      }

      if (message.method === 'getPageElementInventory') {
        sendMessage({
          id: message.id,
          result: await getPageElementInventory(message.params ?? {}),
        })
        return
      }

      if (message.method === 'drawPageTrace') {
        sendMessage({
          id: message.id,
          result: await drawPageTrace(message.params ?? {}),
        })
        return
      }

      if (message.method === 'clickPageElement') {
        sendMessage({
          id: message.id,
          result: await clickPageElement(message.params ?? {}),
        })
        return
      }

      if (message.method === 'typePageElement') {
        sendMessage({
          id: message.id,
          result: await typePageElement(message.params ?? {}),
        })
        return
      }

      if (message.method === 'selectPageElement') {
        sendMessage({
          id: message.id,
          result: await selectPageElement(message.params ?? {}),
        })
        return
      }

      if (message.method === 'scrollPage') {
        sendMessage({
          id: message.id,
          result: await scrollPage(message.params ?? {}),
        })
        return
      }

      const response: ExtensionResponseMessage = { id: message.id }
      try {
        response.result = await handleCommand(message as ExtensionCommandMessage)
      } catch (error: any) {
        logger.debug('Error handling command:', error)
        response.error = error.message
      }
      // logger.debug('Sending response:', response)
      sendMessage(response)
    }

    this.ws.onclose = (event: CloseEvent) => {
      this.handleClose(event.reason, event.code)
    }

    this.ws.onerror = (event: Event) => {
      logger.debug('WebSocket error:', event)
    }

    chrome.debugger.onEvent.addListener(onDebuggerEvent)
    chrome.debugger.onDetach.addListener(onDebuggerDetach)

    logger.debug('Connection established')
  }

  private handleClose(reason: string, code: number): void {
    // Log memory at disconnect time to help diagnose memory-related terminations
    try {
      // @ts-ignore - performance.memory is Chrome-specific
      const mem = performance.memory
      if (mem) {
        const formatMB = (b: number) => (b / 1024 / 1024).toFixed(2) + 'MB'
        logger.warn(
          `DISCONNECT MEMORY: used=${formatMB(mem.usedJSHeapSize)} total=${formatMB(mem.totalJSHeapSize)} limit=${formatMB(mem.jsHeapSizeLimit)}`,
        )
      }
    } catch {}
    logger.warn(`DISCONNECT: WS closed code=${code} reason=${reason || 'none'} stack=${getCallStack()}`)

    chrome.debugger.onEvent.removeListener(onDebuggerEvent)
    chrome.debugger.onDetach.removeListener(onDebuggerDetach)

    const isExtensionReplaced = reason === 'Extension Replaced' || code === 4001
    const isExtensionInUse = reason === 'Extension Already In Use' || code === 4002
    this.preserveTabsOnDetach = !(isExtensionReplaced || isExtensionInUse)

    const { tabs } = store.getState()

    for (const [tabId] of tabs) {
      chrome.debugger.detach({ tabId }).catch((err) => {
        logger.debug('Error detaching from tab:', tabId, err.message)
      })
    }

    childSessions.clear()
    this.ws = null

    // Only one extension can connect to the relay server at a time.
    // Code 4001: Another extension replaced this one (this extension was idle)
    // Code 4002: This extension tried to connect but another is actively in use
    if (isExtensionReplaced) {
      logger.debug('Disconnected: another Playwriter extension connected (this one was idle)')
      store.setState({
        tabs: new Map(),
        connectionState: 'extension-replaced',
        errorText: 'Another Bolt Chrome Extension took over the connection',
      })
      return
    }

    if (isExtensionInUse) {
      logger.debug('Rejected: another Playwriter extension is actively in use')
      store.setState({
        tabs: new Map(),
        connectionState: 'extension-replaced',
        errorText: 'Another Bolt Chrome Extension is actively in use',
      })
      return
    }

    // For normal disconnects, set tabs to 'connecting' state and let maintain loop handle reconnect
    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      for (const [tabId, tab] of newTabs) {
        newTabs.set(tabId, { ...tab, state: 'connecting' })
      }
      return { tabs: newTabs, connectionState: 'idle', errorText: undefined }
    })
  }

  async maintainLoop(): Promise<void> {
    while (true) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        await sleep(1000)
        continue
      }

      // When another Playwriter extension took over, poll until slot is free.
      // Slot is free when: no extension connected, OR connected but no active tabs.
      if (store.getState().connectionState === 'extension-replaced') {
        try {
          const response = await fetch(`http://${RELAY_HOST}:${RELAY_PORT}/extension/status`, {
            method: 'GET',
            signal: AbortSignal.timeout(2000),
          })
          const data = (await response.json()) as { connected: boolean; activeTargets: number }
          const slotAvailable = !data.connected || data.activeTargets === 0
          if (slotAvailable) {
            store.setState({ connectionState: 'idle', errorText: undefined })
            logger.debug(
              'Extension slot is free (connected:',
              data.connected,
              'activeTargets:',
              data.activeTargets,
              '), cleared error state',
            )
          } else {
            logger.debug('Extension slot still taken (activeTargets:', data.activeTargets, '), will retry...')
          }
        } catch {
          logger.debug('Server not available, will retry...')
        }
        await sleep(3000)
        continue
      }

      // Ensure tabs are in 'connecting' state when WS is not connected
      // This handles edge cases where handleClose wasn't called or state got out of sync
      const currentTabs = store.getState().tabs
      const hasConnectedTabs = Array.from(currentTabs.values()).some((t) => t.state === 'connected')
      if (hasConnectedTabs) {
        store.setState((state) => {
          const newTabs = new Map(state.tabs)
          for (const [tabId, tab] of newTabs) {
            if (tab.state === 'connected') {
              newTabs.set(tabId, { ...tab, state: 'connecting' })
            }
          }
          return { tabs: newTabs }
        })
      }

      // Try to connect silently in background - don't show 'connecting' badge
      // Individual tab states will show 'connecting' when user explicitly clicks
      try {
        await this.ensureConnection()
        store.setState({ connectionState: 'connected' })

        // Re-attach any tabs that were in 'connecting' state (from a previous disconnect)
        const tabsToReattach = Array.from(store.getState().tabs.entries())
          .filter(([_, tab]) => tab.state === 'connecting')
          .map(([tabId]) => tabId)

        for (const tabId of tabsToReattach) {
          // Re-check state before attaching - might have been attached by user click
          const currentTab = store.getState().tabs.get(tabId)
          if (!currentTab || currentTab.state !== 'connecting') {
            logger.debug('Skipping reattach, tab state changed:', tabId, currentTab?.state)
            continue
          }

          try {
            await chrome.tabs.get(tabId)
            await attachTab(tabId)
            logger.debug('Successfully re-attached tab:', tabId)
          } catch (error: any) {
            logger.debug('Failed to re-attach tab:', tabId, error.message)
            store.setState((state) => {
              const newTabs = new Map(state.tabs)
              newTabs.delete(tabId)
              return { tabs: newTabs }
            })
          }
        }
        this.preserveTabsOnDetach = false
      } catch (error: any) {
        logger.debug('Connection attempt failed:', error.message)
        // Check if rejected because another extension is actively in use
        if (error.message === 'Extension Already In Use') {
          store.setState({
            connectionState: 'extension-replaced',
            errorText: 'Another Bolt Chrome Extension is actively in use',
          })
        } else {
          store.setState({ connectionState: 'idle' })
        }
      }

      await sleep(3000)
    }
  }
}

export const connectionManager = new ConnectionManager()

export const store = createStore<ExtensionState>(() => ({
  tabs: new Map(),
  connectionState: 'idle',
  currentTabId: undefined,
  errorText: undefined,
}))

// @ts-ignore
globalThis.toggleExtensionForActiveTab = toggleExtensionForActiveTab
// @ts-ignore
globalThis.disconnectEverything = disconnectEverything
// @ts-ignore
globalThis.getExtensionState = () => store.getState()

declare global {
  var toggleExtensionForActiveTab: () => Promise<{ isConnected: boolean; state: ExtensionState }>
  var getExtensionState: () => ExtensionState
  var disconnectEverything: () => Promise<void>
}

const MAX_LOG_STRING_LENGTH = 2000

function truncateLogString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) {
    return value
  }
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}…[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`
}

function safeSerialize(arg: any): string {
  if (arg === undefined) return 'undefined'
  if (arg === null) return 'null'
  if (typeof arg === 'function') return `[Function: ${arg.name || 'anonymous'}]`
  if (typeof arg === 'symbol') return String(arg)
  if (typeof arg === 'string') return truncateLogString(arg)
  if (arg instanceof Error) return truncateLogString(arg.stack || arg.message || String(arg))
  if (typeof arg === 'object') {
    try {
      const seen = new WeakSet()
      const serialized = JSON.stringify(arg, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
          if (value instanceof Map) return { dataType: 'Map', value: Array.from(value.entries()) }
          if (value instanceof Set) return { dataType: 'Set', value: Array.from(value.values()) }
        }
        return value
      })
      return truncateLogString(serialized)
    } catch {
      return truncateLogString(String(arg))
    }
  }
  return truncateLogString(String(arg))
}

function sendLog(level: string, args: any[]) {
  sendMessage({
    method: 'log',
    params: { level, args: args.map(safeSerialize) },
  })
}

export const logger = {
  log: (...args: any[]) => {
    console.log(...args)
    sendLog('log', args)
  },
  debug: (...args: any[]) => {
    console.debug(...args)
    sendLog('debug', args)
  },
  info: (...args: any[]) => {
    console.info(...args)
    sendLog('info', args)
  },
  warn: (...args: any[]) => {
    console.warn(...args)
    sendLog('warn', args)
  },
  error: (...args: any[]) => {
    console.error(...args)
    sendLog('error', args)
  },
}

function getCallStack(): string {
  const stack = new Error().stack || ''
  return stack.split('\n').slice(2, 6).join(' <- ').replace(/\s+/g, ' ')
}

self.addEventListener('error', (event) => {
  const error = event.error
  const stack = error?.stack || `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`
  logger.error('Uncaught error:', stack)
})

self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const stack = reason?.stack || String(reason)
  logger.error('Unhandled promise rejection:', stack)
})

let messageCount = 0
export function sendMessage(message: any): void {
  if (connectionManager.ws?.readyState === WebSocket.OPEN) {
    try {
      connectionManager.ws.send(JSON.stringify(message))
      // Check memory periodically (every ~100 messages)
      if (++messageCount % 100 === 0) {
        checkMemory()
      }
    } catch (error: any) {
      console.debug('ERROR sending message:', error, 'message type:', message.method || 'response')
    }
  }
}

export function getTabBySessionId(sessionId: string): { tabId: number; tab: TabInfo } | undefined {
  for (const [tabId, tab] of store.getState().tabs) {
    if (tab.sessionId === sessionId) {
      return { tabId, tab }
    }
  }
  return undefined
}

function getTabByTargetId(targetId: string): { tabId: number; tab: TabInfo } | undefined {
  for (const [tabId, tab] of store.getState().tabs) {
    if (tab.targetId === targetId) {
      return { tabId, tab }
    }
  }
  return undefined
}

async function arrangeWindowForTarget(params: {
  targetId?: string
  bounds?: {
    left?: number
    top?: number
    width?: number
    height?: number
  }
}): Promise<{ success: true } | { success: false; error: string }> {
  if (!params.targetId) {
    return { success: false, error: 'targetId is required' }
  }

  const found = getTabByTargetId(params.targetId)
  if (!found) {
    return { success: false, error: `No observed tab found for target ${params.targetId}` }
  }

  const { bounds } = params
  const left = Number.isFinite(bounds?.left) ? Math.round(bounds!.left!) : undefined
  const top = Number.isFinite(bounds?.top) ? Math.round(bounds!.top!) : undefined
  const width = Number.isFinite(bounds?.width) ? Math.max(100, Math.round(bounds!.width!)) : undefined
  const height = Number.isFinite(bounds?.height) ? Math.max(100, Math.round(bounds!.height!)) : undefined

  if (left === undefined || top === undefined || width === undefined || height === undefined) {
    return { success: false, error: 'Complete numeric bounds are required' }
  }

  try {
    const tab = await chrome.tabs.get(found.tabId)
    if (tab.windowId === undefined) {
      return { success: false, error: 'Observed tab has no owning window' }
    }

    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true })
    await chrome.tabs.update(found.tabId, { active: true })
    await chrome.windows.update(tab.windowId, {
      left,
      top,
      width,
      height,
      focused: true,
    })
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

async function activateBrowserTab(params: {
  chromeTabId?: number
  windowId?: number
}): Promise<{ success: true } | { success: false; error: string }> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  try {
    const tab = await chrome.tabs.get(chromeTabId)
    if (tab.windowId === undefined) {
      return { success: false, error: 'Browser tab has no owning window' }
    }
    if (params.windowId !== undefined && tab.windowId !== params.windowId) {
      return { success: false, error: 'Browser tab window does not match requested windowId' }
    }

    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true })
    await chrome.tabs.update(chromeTabId, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

async function claimBrowserTab(params: {
  chromeTabId?: number
}): Promise<{
  success: true
  chromeTabId: number
  targetId: string
  sessionId: string
} | { success: false; error: string }> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  const existing = store.getState().tabs.get(chromeTabId)
  if (existing?.state === 'connected' && existing.targetId && existing.sessionId) {
    return {
      success: true,
      chromeTabId,
      targetId: existing.targetId,
      sessionId: existing.sessionId,
    }
  }

  try {
    await chrome.tabs.get(chromeTabId)
    setTabConnecting(chromeTabId)
    await connectionManager.ensureConnection()
    const { targetInfo, sessionId } = await attachTab(chromeTabId, { shareSource: 'agent-created' })
    return {
      success: true,
      chromeTabId,
      targetId: targetInfo.targetId,
      sessionId,
    }
  } catch (error: any) {
    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      newTabs.set(chromeTabId, { state: 'error', errorText: `Error: ${error?.message || String(error)}` })
      return { tabs: newTabs }
    })
    return { success: false, error: error?.message || String(error) }
  }
}

async function listBrowserTabs(): Promise<{
  windows: Array<{
    windowId: number
    focused: boolean
    type: string
    state: string
    tabs: Array<{
      chromeTabId: number
      windowId: number
      index: number
      active: boolean
      highlighted: boolean
      pinned: boolean
      title: string
      url: string
      status: string
      controlState: 'observable' | 'controllable'
      controlStateDetail?: string
      shared: boolean
      shareState?: string
      targetId?: string
      sessionId?: string
    }>
  }>
}> {
  const sharedTabs = store.getState().tabs
  const windows = await chrome.windows.getAll({ populate: true })

  return {
    windows: windows.map((window) => ({
      windowId: window.id ?? -1,
      focused: Boolean(window.focused),
      type: window.type ?? 'unknown',
      state: window.state ?? 'unknown',
      tabs: (window.tabs ?? [])
        .filter((tab): tab is chrome.tabs.Tab & { id: number; windowId: number } => {
          return typeof tab.id === 'number' && typeof tab.windowId === 'number'
        })
        .map((tab) => {
          const shared = sharedTabs.get(tab.id)
          const controlState = shared ? 'controllable' : 'observable'
          return {
            chromeTabId: tab.id,
            windowId: tab.windowId,
            index: tab.index,
            active: Boolean(tab.active),
            highlighted: Boolean(tab.highlighted),
            pinned: Boolean(tab.pinned),
            title: tab.title ?? '',
            url: tab.url ?? '',
            status: tab.status ?? 'unknown',
            controlState,
            controlStateDetail: shared?.state,
            shared: Boolean(shared),
            shareState: shared?.state,
            targetId: shared?.targetId,
            sessionId: shared?.sessionId,
          }
        }),
    })),
  }
}

type PageElementInventoryResult =
  | {
      success: true
      chromeTabId: number
      frames: Array<{
        frameId: number
        chromeDocumentId: string | null
        url: string
        documentRevision: string
        viewport: {
          width: number
          height: number
          scrollX: number
          scrollY: number
          devicePixelRatio: number
          screenBounds: {
            x: number
            y: number
            width: number
            height: number
          } | null
        }
        selectionText: string
        elements: Array<{
          refId: string
          index: number
          tagName: string
          role: string
          name: string
          text: string
          value: string | null
          inputType: string | null
          checked: boolean | null
          disabled: boolean
          editable: boolean
          clickable: boolean
          bounds: {
            x: number
            y: number
            width: number
            height: number
          }
        }>
      }>
    }
  | {
      success: false
      error: string
    }

type PageTraceResult =
  | {
      success: true
      chromeTabId: number
      frameId: number
      refId: string | null
      bounds: {
        x: number
        y: number
        width: number
        height: number
      }
    }
  | {
      success: false
      error: string
    }

type PageClickResult =
  | {
      success: true
      chromeTabId: number
      frameId: number
      refId: string
      bounds: {
        x: number
        y: number
        width: number
        height: number
      }
    }
  | {
      success: false
      error: string
    }

type PageTypeResult =
  | {
      success: true
      chromeTabId: number
      frameId: number
      refId: string
      value: string
      bounds: {
        x: number
        y: number
        width: number
        height: number
      }
    }
  | {
      success: false
      error: string
    }

type PageSelectResult =
  | {
      success: true
      chromeTabId: number
      frameId: number
      refId: string
      value: string
      bounds: {
        x: number
        y: number
        width: number
        height: number
      }
    }
  | {
      success: false
      error: string
    }

type PageScrollResult =
  | {
      success: true
      chromeTabId: number
      frameId: number
      refId?: string
      scrollX: number
      scrollY: number
      viewport: {
        width: number
        height: number
      }
    }
  | {
      success: false
      error: string
    }

async function getPageElementInventory(params: {
  chromeTabId?: number
  maxElements?: number
}): Promise<PageElementInventoryResult> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  const maxElements = Number.isInteger(params.maxElements)
    ? Math.max(1, Math.min(params.maxElements!, MAX_PAGE_ELEMENT_INVENTORY_COUNT))
    : 80

  try {
    await chrome.tabs.get(chromeTabId)
    const results = await chrome.scripting.executeScript({
      target: { tabId: chromeTabId, allFrames: true },
      args: [maxElements],
      func: (maxElementsPerFrame: number) => {
        type InventoryElement = {
          refId: string
          index: number
          tagName: string
          role: string
          name: string
          text: string
          value: string | null
          inputType: string | null
          checked: boolean | null
          disabled: boolean
          editable: boolean
          clickable: boolean
          bounds: {
            x: number
            y: number
            width: number
            height: number
          }
        }

        const compactText = (value: string | null | undefined, maxLength: number) => {
          return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        }

        const stableHash = (value: string) => {
          let hash = 2166136261
          for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
          }
          return (hash >>> 0).toString(36)
        }

        const attribute = (element: Element, name: string) => {
          return compactText(element.getAttribute(name), 240)
        }

        const roleForElement = (element: HTMLElement) => {
          const explicitRole = attribute(element, 'role')
          if (explicitRole) return explicitRole
          const tagName = element.tagName.toLowerCase()
          if (tagName === 'a') return 'link'
          if (tagName === 'button') return 'button'
          if (tagName === 'select') return 'combobox'
          if (tagName === 'textarea') return 'textbox'
          if (tagName === 'input') {
            const type = (element as HTMLInputElement).type || 'text'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
            return 'textbox'
          }
          if (element.isContentEditable) return 'textbox'
          return tagName
        }

        const nameForElement = (element: HTMLElement) => {
          return compactText(
            element.getAttribute('aria-label')
              || element.getAttribute('title')
              || element.getAttribute('alt')
              || element.getAttribute('placeholder')
              || element.getAttribute('name')
              || element.textContent,
            240,
          )
        }

        const valueForElement = (element: HTMLElement) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return compactText(element.value, 240)
          }
          return null
        }

        const isElementVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false
          }
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const isClickable = (element: HTMLElement) => {
          const tagName = element.tagName.toLowerCase()
          return tagName === 'a'
            || tagName === 'button'
            || element.getAttribute('role') === 'button'
            || typeof element.onclick === 'function'
            || element.tabIndex >= 0
        }

        const isEditable = (element: HTMLElement) => {
          return element instanceof HTMLInputElement
            || element instanceof HTMLTextAreaElement
            || element instanceof HTMLSelectElement
            || element.isContentEditable
        }

        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          'a, button, input, textarea, select, summary, [role], [tabindex], [contenteditable="true"], [onclick]',
        ))
        const elements: InventoryElement[] = []
        const browserChromeX = Math.max(0, window.outerWidth - window.innerWidth)
        const browserChromeY = Math.max(0, window.outerHeight - window.innerHeight)
        const viewportScreenBounds = Number.isFinite(window.screenX)
          && Number.isFinite(window.screenY)
          && window.innerWidth > 0
          && window.innerHeight > 0
          ? {
              x: Math.round(window.screenX + browserChromeX / 2),
              y: Math.round(window.screenY + browserChromeY - browserChromeX / 2),
              width: Math.round(window.innerWidth),
              height: Math.round(window.innerHeight),
            }
          : null

        for (const element of candidates) {
          if (elements.length >= maxElementsPerFrame) break
          if (!isElementVisible(element)) continue

          const rect = element.getBoundingClientRect()
          const input = element instanceof HTMLInputElement ? element : null
          const index = elements.length
          const role = roleForElement(element)
          const name = nameForElement(element)
          const text = compactText(element.textContent, 500)
          const value = valueForElement(element)

          elements.push({
            refId: '',
            index,
            tagName: element.tagName.toLowerCase(),
            role,
            name,
            text,
            value,
            inputType: input?.type ?? null,
            checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : null,
            disabled: Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
            editable: isEditable(element),
            clickable: isClickable(element),
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          })
        }
        const documentRevision = stableHash(JSON.stringify({
          url: window.location.href,
          elements: elements.map((element) => ({
            index: element.index,
            tagName: element.tagName,
            role: element.role,
            name: element.name,
            text: element.text,
            value: element.value,
            inputType: element.inputType,
            checked: element.checked,
            disabled: element.disabled,
            editable: element.editable,
            clickable: element.clickable,
            bounds: element.bounds,
          })),
        }))
        for (const element of elements) {
          element.refId = `browser-element:${documentRevision}:${element.index}`
        }
        const selectionText = compactText(window.getSelection()?.toString(), 2000)

        return {
          url: window.location.href,
          documentRevision,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            devicePixelRatio: window.devicePixelRatio,
            screenBounds: viewportScreenBounds,
          },
          selectionText,
          elements,
        }
      },
    })

    return {
      success: true,
      chromeTabId,
      frames: results.map((result) => ({
        frameId: result.frameId,
        chromeDocumentId: typeof result.documentId === 'string' ? result.documentId : null,
        url: result.result?.url ?? '',
        documentRevision: result.result?.documentRevision ?? '',
        viewport: result.result?.viewport ?? {
          width: 0,
          height: 0,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 1,
          screenBounds: null,
        },
        selectionText: result.result?.selectionText ?? '',
        elements: result.result?.elements ?? [],
      })),
    }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

async function drawPageTrace(params: {
  chromeTabId?: number
  frameId?: number
  refId?: string
  bounds?: {
    x?: number
    y?: number
    width?: number
    height?: number
  }
  durationMs?: number
}): Promise<PageTraceResult> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  const frameId = Number.isInteger(params.frameId) ? params.frameId! : 0
  const refId = typeof params.refId === 'string' && params.refId.trim() ? params.refId.trim() : null
  const inputBounds = params.bounds
  const hasBounds = Boolean(
    inputBounds
      && Number.isFinite(inputBounds.x)
      && Number.isFinite(inputBounds.y)
      && Number.isFinite(inputBounds.width)
      && Number.isFinite(inputBounds.height)
      && inputBounds.width! > 0
      && inputBounds.height! > 0,
  )
  if (!refId && !hasBounds) {
    return { success: false, error: 'refId or bounds is required' }
  }
  const traceBounds = hasBounds
    ? {
        x: inputBounds!.x!,
        y: inputBounds!.y!,
        width: inputBounds!.width!,
        height: inputBounds!.height!,
      }
    : null

  const durationMs = Number.isInteger(params.durationMs)
    ? Math.max(100, Math.min(params.durationMs!, 10_000))
    : 900

  try {
    await chrome.tabs.get(chromeTabId)
    const results = await chrome.scripting.executeScript({
      target: frameId > 0 ? { tabId: chromeTabId, frameIds: [frameId] } : { tabId: chromeTabId },
      args: [refId, traceBounds, durationMs],
      func: (
        requestedRefId: string | null,
        requestedBounds: { x?: number; y?: number; width?: number; height?: number } | null,
        traceDurationMs: number,
      ) => {
        const TRACE_ID = 'interpreter-browser-control-trace'

        const compactText = (value: string | null | undefined, maxLength: number) => {
          return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        }

        const stableHash = (value: string) => {
          let hash = 2166136261
          for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
          }
          return (hash >>> 0).toString(36)
        }

        const attribute = (element: Element, name: string) => {
          return compactText(element.getAttribute(name), 240)
        }

        const roleForElement = (element: HTMLElement) => {
          const explicitRole = attribute(element, 'role')
          if (explicitRole) return explicitRole
          const tagName = element.tagName.toLowerCase()
          if (tagName === 'a') return 'link'
          if (tagName === 'button') return 'button'
          if (tagName === 'select') return 'combobox'
          if (tagName === 'textarea') return 'textbox'
          if (tagName === 'input') {
            const type = (element as HTMLInputElement).type || 'text'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
            return 'textbox'
          }
          if (element.isContentEditable) return 'textbox'
          return tagName
        }

        const nameForElement = (element: HTMLElement) => {
          return compactText(
            element.getAttribute('aria-label')
              || element.getAttribute('title')
              || element.getAttribute('alt')
              || element.getAttribute('placeholder')
              || element.getAttribute('name')
              || element.textContent,
            240,
          )
        }

        const valueForElement = (element: HTMLElement) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return compactText(element.value, 240)
          }
          return null
        }

        const isElementVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false
          }
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const isClickable = (element: HTMLElement) => {
          const tagName = element.tagName.toLowerCase()
          return tagName === 'a'
            || tagName === 'button'
            || element.getAttribute('role') === 'button'
            || typeof element.onclick === 'function'
            || element.tabIndex >= 0
        }

        const isEditable = (element: HTMLElement) => {
          return element instanceof HTMLInputElement
            || element instanceof HTMLTextAreaElement
            || element instanceof HTMLSelectElement
            || element.isContentEditable
        }

        const resolveBoundsForRef = () => {
          if (!requestedRefId) return null

          const candidates = Array.from(document.querySelectorAll<HTMLElement>(
            'a, button, input, textarea, select, summary, [role], [tabindex], [contenteditable="true"], [onclick]',
          ))
          const elements = []

          for (const element of candidates) {
            if (!isElementVisible(element)) continue
            const rect = element.getBoundingClientRect()
            const input = element instanceof HTMLInputElement ? element : null
            elements.push({
              element,
              index: elements.length,
              tagName: element.tagName.toLowerCase(),
              role: roleForElement(element),
              name: nameForElement(element),
              text: compactText(element.textContent, 500),
              value: valueForElement(element),
              inputType: input?.type ?? null,
              checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : null,
              disabled: Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
              editable: isEditable(element),
              clickable: isClickable(element),
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            })
          }

          const documentRevision = stableHash(JSON.stringify({
            url: window.location.href,
            elements: elements.map((element) => ({
              index: element.index,
              tagName: element.tagName,
              role: element.role,
              name: element.name,
              text: element.text,
              value: element.value,
              inputType: element.inputType,
              checked: element.checked,
              disabled: element.disabled,
              editable: element.editable,
              clickable: element.clickable,
              bounds: element.bounds,
            })),
          }))

          const match = elements.find((element) => {
            return `browser-element:${documentRevision}:${element.index}` === requestedRefId
          })
          if (!match) return null

          return match.bounds
        }

        const traceBounds = requestedBounds && Number.isFinite(requestedBounds.x) && Number.isFinite(requestedBounds.y)
          && Number.isFinite(requestedBounds.width) && Number.isFinite(requestedBounds.height)
          && requestedBounds.width! > 0 && requestedBounds.height! > 0
          ? {
              x: Math.round(requestedBounds.x!),
              y: Math.round(requestedBounds.y!),
              width: Math.round(requestedBounds.width!),
              height: Math.round(requestedBounds.height!),
            }
          : resolveBoundsForRef()
        if (!traceBounds) {
          return { success: false as const, error: 'refId is stale or not visible' }
        }

        const existing = document.getElementById(TRACE_ID)
        existing?.remove()

        const trace = document.createElement('div')
        trace.id = TRACE_ID
        trace.setAttribute('aria-hidden', 'true')
        trace.style.position = 'absolute'
        trace.style.left = `${traceBounds.x + window.scrollX}px`
        trace.style.top = `${traceBounds.y + window.scrollY}px`
        trace.style.width = `${traceBounds.width}px`
        trace.style.height = `${traceBounds.height}px`
        trace.style.pointerEvents = 'none'
        trace.style.boxSizing = 'border-box'
        trace.style.border = '2px solid rgba(64, 148, 255, 0.95)'
        trace.style.background = 'rgba(64, 148, 255, 0.14)'
        trace.style.boxShadow = '0 0 0 4px rgba(64, 148, 255, 0.18)'
        trace.style.borderRadius = '8px'
        trace.style.zIndex = '2147483647'
        trace.style.transition = 'opacity 160ms ease'
        ;(document.body || document.documentElement).appendChild(trace)

        window.setTimeout(() => {
          trace.style.opacity = '0'
          window.setTimeout(() => trace.remove(), 180)
        }, traceDurationMs)

        return { success: true as const, bounds: traceBounds }
      },
    })

    const result = results[0]
    if (result?.result?.success !== true) {
      return { success: false, error: result?.result?.error ?? 'Page trace failed' }
    }

    return {
      success: true,
      chromeTabId,
      frameId: result.frameId,
      refId,
      bounds: result.result.bounds,
    }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

async function clickPageElement(params: {
  chromeTabId?: number
  frameId?: number
  refId?: string
  durationMs?: number
}): Promise<PageClickResult> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  const frameId = Number.isInteger(params.frameId) ? params.frameId! : 0
  const refId = typeof params.refId === 'string' && params.refId.trim() ? params.refId.trim() : null
  if (!refId) {
    return { success: false, error: 'refId is required' }
  }

  const durationMs = Number.isInteger(params.durationMs)
    ? Math.max(100, Math.min(params.durationMs!, 10_000))
    : 900

  try {
    await chrome.tabs.get(chromeTabId)
    const results = await chrome.scripting.executeScript({
      target: frameId > 0 ? { tabId: chromeTabId, frameIds: [frameId] } : { tabId: chromeTabId },
      args: [refId, durationMs],
      func: (requestedRefId: string, traceDurationMs: number) => {
        const TRACE_ID = 'interpreter-browser-control-trace'

        const compactText = (value: string | null | undefined, maxLength: number) => {
          return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        }

        const stableHash = (value: string) => {
          let hash = 2166136261
          for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
          }
          return (hash >>> 0).toString(36)
        }

        const attribute = (element: Element, name: string) => {
          return compactText(element.getAttribute(name), 240)
        }

        const roleForElement = (element: HTMLElement) => {
          const explicitRole = attribute(element, 'role')
          if (explicitRole) return explicitRole
          const tagName = element.tagName.toLowerCase()
          if (tagName === 'a') return 'link'
          if (tagName === 'button') return 'button'
          if (tagName === 'select') return 'combobox'
          if (tagName === 'textarea') return 'textbox'
          if (tagName === 'input') {
            const type = (element as HTMLInputElement).type || 'text'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
            return 'textbox'
          }
          if (element.isContentEditable) return 'textbox'
          return tagName
        }

        const nameForElement = (element: HTMLElement) => {
          return compactText(
            element.getAttribute('aria-label')
              || element.getAttribute('title')
              || element.getAttribute('alt')
              || element.getAttribute('placeholder')
              || element.getAttribute('name')
              || element.textContent,
            240,
          )
        }

        const valueForElement = (element: HTMLElement) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return compactText(element.value, 240)
          }
          return null
        }

        const isElementVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false
          }
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const isClickable = (element: HTMLElement) => {
          const tagName = element.tagName.toLowerCase()
          return tagName === 'a'
            || tagName === 'button'
            || element.getAttribute('role') === 'button'
            || typeof element.onclick === 'function'
            || element.tabIndex >= 0
        }

        const isEditable = (element: HTMLElement) => {
          return element instanceof HTMLInputElement
            || element instanceof HTMLTextAreaElement
            || element instanceof HTMLSelectElement
            || element.isContentEditable
        }

        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          'a, button, input, textarea, select, summary, [role], [tabindex], [contenteditable="true"], [onclick]',
        ))
        const elements = []

        for (const element of candidates) {
          if (!isElementVisible(element)) continue
          const rect = element.getBoundingClientRect()
          const input = element instanceof HTMLInputElement ? element : null
          elements.push({
            element,
            index: elements.length,
            tagName: element.tagName.toLowerCase(),
            role: roleForElement(element),
            name: nameForElement(element),
            text: compactText(element.textContent, 500),
            value: valueForElement(element),
            inputType: input?.type ?? null,
            checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : null,
            disabled: Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
            editable: isEditable(element),
            clickable: isClickable(element),
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          })
        }

        const documentRevision = stableHash(JSON.stringify({
          url: window.location.href,
          elements: elements.map((element) => ({
            index: element.index,
            tagName: element.tagName,
            role: element.role,
            name: element.name,
            text: element.text,
            value: element.value,
            inputType: element.inputType,
            checked: element.checked,
            disabled: element.disabled,
            editable: element.editable,
            clickable: element.clickable,
            bounds: element.bounds,
          })),
        }))

        const match = elements.find((element) => {
          return `browser-element:${documentRevision}:${element.index}` === requestedRefId
        })
        if (!match) {
          return { success: false as const, error: 'refId is stale or not visible' }
        }
        if (match.disabled) {
          return { success: false as const, error: 'element is disabled' }
        }

        const existing = document.getElementById(TRACE_ID)
        existing?.remove()

        const trace = document.createElement('div')
        trace.id = TRACE_ID
        trace.setAttribute('aria-hidden', 'true')
        trace.style.position = 'absolute'
        trace.style.left = `${match.bounds.x + window.scrollX}px`
        trace.style.top = `${match.bounds.y + window.scrollY}px`
        trace.style.width = `${match.bounds.width}px`
        trace.style.height = `${match.bounds.height}px`
        trace.style.pointerEvents = 'none'
        trace.style.boxSizing = 'border-box'
        trace.style.border = '2px solid rgba(64, 148, 255, 0.95)'
        trace.style.background = 'rgba(64, 148, 255, 0.14)'
        trace.style.boxShadow = '0 0 0 4px rgba(64, 148, 255, 0.18)'
        trace.style.borderRadius = '8px'
        trace.style.zIndex = '2147483647'
        trace.style.transition = 'opacity 160ms ease'
        ;(document.body || document.documentElement).appendChild(trace)

        window.setTimeout(() => {
          trace.style.opacity = '0'
          window.setTimeout(() => trace.remove(), 180)
        }, traceDurationMs)

        match.element.click()

        return { success: true as const, bounds: match.bounds }
      },
    })

    const result = results[0]
    if (result?.result?.success !== true) {
      return { success: false, error: result?.result?.error ?? 'Page click failed' }
    }

    return {
      success: true,
      chromeTabId,
      frameId: result.frameId,
      refId,
      bounds: result.result.bounds,
    }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

async function typePageElement(params: {
  chromeTabId?: number
  frameId?: number
  refId?: string
  text?: string
  durationMs?: number
}): Promise<PageTypeResult> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  const frameId = Number.isInteger(params.frameId) ? params.frameId! : 0
  const refId = typeof params.refId === 'string' && params.refId.trim() ? params.refId.trim() : null
  if (!refId) {
    return { success: false, error: 'refId is required' }
  }
  if (typeof params.text !== 'string') {
    return { success: false, error: 'text is required' }
  }

  const durationMs = Number.isInteger(params.durationMs)
    ? Math.max(100, Math.min(params.durationMs!, 10_000))
    : 900

  try {
    await chrome.tabs.get(chromeTabId)
    const results = await chrome.scripting.executeScript({
      target: frameId > 0 ? { tabId: chromeTabId, frameIds: [frameId] } : { tabId: chromeTabId },
      args: [refId, params.text, durationMs],
      func: (requestedRefId: string, requestedText: string, traceDurationMs: number) => {
        const TRACE_ID = 'interpreter-browser-control-trace'

        const compactText = (value: string | null | undefined, maxLength: number) => {
          return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        }

        const stableHash = (value: string) => {
          let hash = 2166136261
          for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
          }
          return (hash >>> 0).toString(36)
        }

        const attribute = (element: Element, name: string) => {
          return compactText(element.getAttribute(name), 240)
        }

        const roleForElement = (element: HTMLElement) => {
          const explicitRole = attribute(element, 'role')
          if (explicitRole) return explicitRole
          const tagName = element.tagName.toLowerCase()
          if (tagName === 'a') return 'link'
          if (tagName === 'button') return 'button'
          if (tagName === 'select') return 'combobox'
          if (tagName === 'textarea') return 'textbox'
          if (tagName === 'input') {
            const type = (element as HTMLInputElement).type || 'text'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
            return 'textbox'
          }
          if (element.isContentEditable) return 'textbox'
          return tagName
        }

        const nameForElement = (element: HTMLElement) => {
          return compactText(
            element.getAttribute('aria-label')
              || element.getAttribute('title')
              || element.getAttribute('alt')
              || element.getAttribute('placeholder')
              || element.getAttribute('name')
              || element.textContent,
            240,
          )
        }

        const valueForElement = (element: HTMLElement) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return compactText(element.value, 240)
          }
          return null
        }

        const isElementVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false
          }
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const isClickable = (element: HTMLElement) => {
          const tagName = element.tagName.toLowerCase()
          return tagName === 'a'
            || tagName === 'button'
            || element.getAttribute('role') === 'button'
            || typeof element.onclick === 'function'
            || element.tabIndex >= 0
        }

        const isEditable = (element: HTMLElement) => {
          return element instanceof HTMLInputElement
            || element instanceof HTMLTextAreaElement
            || element instanceof HTMLSelectElement
            || element.isContentEditable
        }

        const canReceiveText = (element: HTMLElement) => {
          if (element instanceof HTMLTextAreaElement || element.isContentEditable) {
            return true
          }
          if (!(element instanceof HTMLInputElement)) {
            return false
          }
          return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type)
        }

        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          'a, button, input, textarea, select, summary, [role], [tabindex], [contenteditable="true"], [onclick]',
        ))
        const elements = []

        for (const element of candidates) {
          if (!isElementVisible(element)) continue
          const rect = element.getBoundingClientRect()
          const input = element instanceof HTMLInputElement ? element : null
          elements.push({
            element,
            index: elements.length,
            tagName: element.tagName.toLowerCase(),
            role: roleForElement(element),
            name: nameForElement(element),
            text: compactText(element.textContent, 500),
            value: valueForElement(element),
            inputType: input?.type ?? null,
            checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : null,
            disabled: Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
            editable: isEditable(element),
            clickable: isClickable(element),
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          })
        }

        const documentRevision = stableHash(JSON.stringify({
          url: window.location.href,
          elements: elements.map((element) => ({
            index: element.index,
            tagName: element.tagName,
            role: element.role,
            name: element.name,
            text: element.text,
            value: element.value,
            inputType: element.inputType,
            checked: element.checked,
            disabled: element.disabled,
            editable: element.editable,
            clickable: element.clickable,
            bounds: element.bounds,
          })),
        }))

        const match = elements.find((element) => {
          return `browser-element:${documentRevision}:${element.index}` === requestedRefId
        })
        if (!match) {
          return { success: false as const, error: 'refId is stale or not visible' }
        }
        if (match.disabled) {
          return { success: false as const, error: 'element is disabled' }
        }
        if (!canReceiveText(match.element)) {
          return { success: false as const, error: 'element is not editable text' }
        }

        const existing = document.getElementById(TRACE_ID)
        existing?.remove()

        const trace = document.createElement('div')
        trace.id = TRACE_ID
        trace.setAttribute('aria-hidden', 'true')
        trace.style.position = 'absolute'
        trace.style.left = `${match.bounds.x + window.scrollX}px`
        trace.style.top = `${match.bounds.y + window.scrollY}px`
        trace.style.width = `${match.bounds.width}px`
        trace.style.height = `${match.bounds.height}px`
        trace.style.pointerEvents = 'none'
        trace.style.boxSizing = 'border-box'
        trace.style.border = '2px solid rgba(64, 148, 255, 0.95)'
        trace.style.background = 'rgba(64, 148, 255, 0.14)'
        trace.style.boxShadow = '0 0 0 4px rgba(64, 148, 255, 0.18)'
        trace.style.borderRadius = '8px'
        trace.style.zIndex = '2147483647'
        trace.style.transition = 'opacity 160ms ease'
        ;(document.body || document.documentElement).appendChild(trace)

        window.setTimeout(() => {
          trace.style.opacity = '0'
          window.setTimeout(() => trace.remove(), 180)
        }, traceDurationMs)

        match.element.focus()
        if (match.element instanceof HTMLInputElement || match.element instanceof HTMLTextAreaElement) {
          match.element.value = requestedText
          match.element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: requestedText }))
          match.element.dispatchEvent(new Event('change', { bubbles: true }))
          return { success: true as const, bounds: match.bounds, value: match.element.value }
        }

        match.element.textContent = requestedText
        match.element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: requestedText }))
        match.element.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true as const, bounds: match.bounds, value: match.element.textContent ?? '' }
      },
    })

    const result = results[0]
    if (result?.result?.success !== true) {
      return { success: false, error: result?.result?.error ?? 'Page type failed' }
    }

    return {
      success: true,
      chromeTabId,
      frameId: result.frameId,
      refId,
      value: result.result.value,
      bounds: result.result.bounds,
    }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

async function selectPageElement(params: {
  chromeTabId?: number
  frameId?: number
  refId?: string
  value?: string
  durationMs?: number
}): Promise<PageSelectResult> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  const frameId = Number.isInteger(params.frameId) ? params.frameId! : 0
  const refId = typeof params.refId === 'string' && params.refId.trim() ? params.refId.trim() : null
  if (!refId) {
    return { success: false, error: 'refId is required' }
  }
  if (typeof params.value !== 'string') {
    return { success: false, error: 'value is required' }
  }

  const durationMs = Number.isInteger(params.durationMs)
    ? Math.max(100, Math.min(params.durationMs!, 10_000))
    : 900

  try {
    await chrome.tabs.get(chromeTabId)
    const results = await chrome.scripting.executeScript({
      target: frameId > 0 ? { tabId: chromeTabId, frameIds: [frameId] } : { tabId: chromeTabId },
      args: [refId, params.value, durationMs],
      func: (requestedRefId: string, requestedValue: string, traceDurationMs: number) => {
        const TRACE_ID = 'interpreter-browser-control-trace'

        const compactText = (value: string | null | undefined, maxLength: number) => {
          return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        }

        const stableHash = (value: string) => {
          let hash = 2166136261
          for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
          }
          return (hash >>> 0).toString(36)
        }

        const attribute = (element: Element, name: string) => {
          return compactText(element.getAttribute(name), 240)
        }

        const roleForElement = (element: HTMLElement) => {
          const explicitRole = attribute(element, 'role')
          if (explicitRole) return explicitRole
          const tagName = element.tagName.toLowerCase()
          if (tagName === 'a') return 'link'
          if (tagName === 'button') return 'button'
          if (tagName === 'select') return 'combobox'
          if (tagName === 'textarea') return 'textbox'
          if (tagName === 'input') {
            const type = (element as HTMLInputElement).type || 'text'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
            return 'textbox'
          }
          if (element.isContentEditable) return 'textbox'
          return tagName
        }

        const nameForElement = (element: HTMLElement) => {
          return compactText(
            element.getAttribute('aria-label')
              || element.getAttribute('title')
              || element.getAttribute('alt')
              || element.getAttribute('placeholder')
              || element.getAttribute('name')
              || element.textContent,
            240,
          )
        }

        const valueForElement = (element: HTMLElement) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return compactText(element.value, 240)
          }
          return null
        }

        const isElementVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false
          }
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const isClickable = (element: HTMLElement) => {
          const tagName = element.tagName.toLowerCase()
          return tagName === 'a'
            || tagName === 'button'
            || element.getAttribute('role') === 'button'
            || typeof element.onclick === 'function'
            || element.tabIndex >= 0
        }

        const isEditable = (element: HTMLElement) => {
          return element instanceof HTMLInputElement
            || element instanceof HTMLTextAreaElement
            || element instanceof HTMLSelectElement
            || element.isContentEditable
        }

        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          'a, button, input, textarea, select, summary, [role], [tabindex], [contenteditable="true"], [onclick]',
        ))
        const elements = []

        for (const element of candidates) {
          if (!isElementVisible(element)) continue
          const rect = element.getBoundingClientRect()
          const input = element instanceof HTMLInputElement ? element : null
          elements.push({
            element,
            index: elements.length,
            tagName: element.tagName.toLowerCase(),
            role: roleForElement(element),
            name: nameForElement(element),
            text: compactText(element.textContent, 500),
            value: valueForElement(element),
            inputType: input?.type ?? null,
            checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : null,
            disabled: Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
            editable: isEditable(element),
            clickable: isClickable(element),
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          })
        }

        const documentRevision = stableHash(JSON.stringify({
          url: window.location.href,
          elements: elements.map((element) => ({
            index: element.index,
            tagName: element.tagName,
            role: element.role,
            name: element.name,
            text: element.text,
            value: element.value,
            inputType: element.inputType,
            checked: element.checked,
            disabled: element.disabled,
            editable: element.editable,
            clickable: element.clickable,
            bounds: element.bounds,
          })),
        }))

        const match = elements.find((element) => {
          return `browser-element:${documentRevision}:${element.index}` === requestedRefId
        })
        if (!match) {
          return { success: false as const, error: 'refId is stale or not visible' }
        }
        if (match.disabled) {
          return { success: false as const, error: 'element is disabled' }
        }
        if (!(match.element instanceof HTMLSelectElement)) {
          return { success: false as const, error: 'element is not a select' }
        }
        if (!Array.from(match.element.options).some((option) => option.value === requestedValue)) {
          return { success: false as const, error: 'select option value not found' }
        }

        const existing = document.getElementById(TRACE_ID)
        existing?.remove()

        const trace = document.createElement('div')
        trace.id = TRACE_ID
        trace.setAttribute('aria-hidden', 'true')
        trace.style.position = 'absolute'
        trace.style.left = `${match.bounds.x + window.scrollX}px`
        trace.style.top = `${match.bounds.y + window.scrollY}px`
        trace.style.width = `${match.bounds.width}px`
        trace.style.height = `${match.bounds.height}px`
        trace.style.pointerEvents = 'none'
        trace.style.boxSizing = 'border-box'
        trace.style.border = '2px solid rgba(64, 148, 255, 0.95)'
        trace.style.background = 'rgba(64, 148, 255, 0.14)'
        trace.style.boxShadow = '0 0 0 4px rgba(64, 148, 255, 0.18)'
        trace.style.borderRadius = '8px'
        trace.style.zIndex = '2147483647'
        trace.style.transition = 'opacity 160ms ease'
        ;(document.body || document.documentElement).appendChild(trace)

        window.setTimeout(() => {
          trace.style.opacity = '0'
          window.setTimeout(() => trace.remove(), 180)
        }, traceDurationMs)

        match.element.focus()
        match.element.value = requestedValue
        match.element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: requestedValue }))
        match.element.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true as const, bounds: match.bounds, value: match.element.value }
      },
    })

    const result = results[0]
    if (result?.result?.success !== true) {
      return { success: false, error: result?.result?.error ?? 'Page select failed' }
    }

    return {
      success: true,
      chromeTabId,
      frameId: result.frameId,
      refId,
      value: result.result.value,
      bounds: result.result.bounds,
    }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

async function scrollPage(params: {
  chromeTabId?: number
  frameId?: number
  refId?: string
  deltaX?: number
  deltaY?: number
}): Promise<PageScrollResult> {
  const chromeTabId = Number.isInteger(params.chromeTabId) ? params.chromeTabId : null
  if (!chromeTabId || chromeTabId < 1) {
    return { success: false, error: 'chromeTabId is required' }
  }

  const frameId = Number.isInteger(params.frameId) ? params.frameId! : 0
  const refId = typeof params.refId === 'string' && params.refId.trim() ? params.refId.trim() : null
  const deltaX = Number.isFinite(params.deltaX) ? params.deltaX! : 0
  const deltaY = Number.isFinite(params.deltaY) ? params.deltaY! : 0
  if (deltaX === 0 && deltaY === 0) {
    return { success: false, error: 'deltaX or deltaY is required' }
  }

  try {
    await chrome.tabs.get(chromeTabId)
    const results = await chrome.scripting.executeScript({
      target: frameId > 0 ? { tabId: chromeTabId, frameIds: [frameId] } : { tabId: chromeTabId },
      args: [deltaX, deltaY, refId],
      func: (requestedDeltaX: number, requestedDeltaY: number, requestedRefId: string | null) => {
        const compactText = (value: string | null | undefined, maxLength: number) => {
          return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        }

        const stableHash = (value: string) => {
          let hash = 2166136261
          for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
          }
          return (hash >>> 0).toString(36)
        }

        const attribute = (element: Element, name: string) => {
          return compactText(element.getAttribute(name), 240)
        }

        const roleForElement = (element: HTMLElement) => {
          const explicitRole = attribute(element, 'role')
          if (explicitRole) return explicitRole
          const tagName = element.tagName.toLowerCase()
          if (tagName === 'a') return 'link'
          if (tagName === 'button') return 'button'
          if (tagName === 'select') return 'combobox'
          if (tagName === 'textarea') return 'textbox'
          if (tagName === 'input') {
            const type = (element as HTMLInputElement).type || 'text'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
            return 'textbox'
          }
          if (element.isContentEditable) return 'textbox'
          return tagName
        }

        const nameForElement = (element: HTMLElement) => {
          return compactText(
            element.getAttribute('aria-label')
              || element.getAttribute('title')
              || element.getAttribute('alt')
              || element.getAttribute('placeholder')
              || element.getAttribute('name')
              || element.textContent,
            240,
          )
        }

        const valueForElement = (element: HTMLElement) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            return compactText(element.value, 240)
          }
          return null
        }

        const isElementVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false
          }
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const isClickable = (element: HTMLElement) => {
          const tagName = element.tagName.toLowerCase()
          return tagName === 'a'
            || tagName === 'button'
            || element.getAttribute('role') === 'button'
            || typeof element.onclick === 'function'
            || element.tabIndex >= 0
        }

        const isEditable = (element: HTMLElement) => {
          return element instanceof HTMLInputElement
            || element instanceof HTMLTextAreaElement
            || element instanceof HTMLSelectElement
            || element.isContentEditable
        }

        let scroller: Element | Window = window
        if (requestedRefId) {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>(
            'a, button, input, textarea, select, summary, [role], [tabindex], [contenteditable="true"], [onclick]',
          ))
          const elements = []
          for (const element of candidates) {
            if (!isElementVisible(element)) continue
            const rect = element.getBoundingClientRect()
            const input = element instanceof HTMLInputElement ? element : null
            elements.push({
              element,
              index: elements.length,
              tagName: element.tagName.toLowerCase(),
              role: roleForElement(element),
              name: nameForElement(element),
              text: compactText(element.textContent, 500),
              value: valueForElement(element),
              inputType: input?.type ?? null,
              checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : null,
              disabled: Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
              editable: isEditable(element),
              clickable: isClickable(element),
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            })
          }
          const documentRevision = stableHash(JSON.stringify({
            url: window.location.href,
            elements: elements.map((element) => ({
              index: element.index,
              tagName: element.tagName,
              role: element.role,
              name: element.name,
              text: element.text,
              value: element.value,
              inputType: element.inputType,
              checked: element.checked,
              disabled: element.disabled,
              editable: element.editable,
              clickable: element.clickable,
              bounds: element.bounds,
            })),
          }))
          const match = elements.find((element) => `browser-element:${documentRevision}:${element.index}` === requestedRefId)
          if (!match) {
            return { success: false as const, error: 'refId is stale or not visible' }
          }
          for (let current: HTMLElement | null = match.element; current; current = current.parentElement) {
            const style = window.getComputedStyle(current)
            const overflowX = style.overflowX
            const overflowY = style.overflowY
            const canScrollX = current.scrollWidth > current.clientWidth && ['auto', 'scroll', 'overlay'].includes(overflowX)
            const canScrollY = current.scrollHeight > current.clientHeight && ['auto', 'scroll', 'overlay'].includes(overflowY)
            if ((requestedDeltaX !== 0 && canScrollX) || (requestedDeltaY !== 0 && canScrollY)) {
              scroller = current
              break
            }
          }
        }

        if (scroller === window) {
          window.scrollBy(requestedDeltaX, requestedDeltaY)
        } else {
          scroller.scrollBy(requestedDeltaX, requestedDeltaY)
        }
        const scrollX = scroller === window
          ? Math.round(window.scrollX)
          : Math.round((scroller as Element).scrollLeft)
        const scrollY = scroller === window
          ? Math.round(window.scrollY)
          : Math.round((scroller as Element).scrollTop)
        return {
          success: true as const,
          refId: requestedRefId ?? undefined,
          scrollX,
          scrollY,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        }
      },
    })

    const result = results[0]
    if (result?.result?.success !== true) {
      return { success: false, error: 'Page scroll failed' }
    }

    return {
      success: true,
      chromeTabId,
      frameId: result.frameId,
      refId: result.result.refId,
      scrollX: result.result.scrollX,
      scrollY: result.result.scrollY,
      viewport: result.result.viewport,
    }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

function emitChildDetachesForTab(tabId: number): void {
  const childEntries = Array.from(childSessions.entries()).filter(([_, parentTab]) => parentTab.tabId === tabId)

  childEntries.forEach(([childSessionId, parentTab]) => {
    const childDetachParams: Protocol.Target.DetachedFromTargetEvent = parentTab.targetId
      ? { sessionId: childSessionId, targetId: parentTab.targetId }
      : { sessionId: childSessionId }
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: childDetachParams,
      },
    })
    logger.debug('Cleaning up child session:', childSessionId, 'for tab:', tabId)
    childSessions.delete(childSessionId)
  })
}

// Resolve which tab a CDP command targets by checking sessionId sources in priority order:
// 1. Top-level sessionId (the CDP session the command was sent on)
// 2. params.sessionId (e.g. Target.detachFromTarget on the root session, see #40)
// 3. params.targetId (e.g. Target.closeTarget)
function getTabForCommand(msg: ExtensionCommandMessage): { tabId: number; tab: TabInfo } | undefined {
  const sessionId = msg.params.sessionId
  if (sessionId) {
    const found = getTabBySessionId(sessionId)
    if (found) {
      return found
    }
    const child = childSessions.get(sessionId)
    if (child) {
      const tab = store.getState().tabs.get(child.tabId)
      if (tab) {
        return { tabId: child.tabId, tab }
      }
    }
  }

  const paramsSessionId =
    msg.params.params && 'sessionId' in msg.params.params && typeof msg.params.params.sessionId === 'string'
      ? msg.params.params.sessionId
      : undefined
  if (paramsSessionId) {
    const found = getTabBySessionId(paramsSessionId)
    if (found) {
      return found
    }
    const child = childSessions.get(paramsSessionId)
    if (child) {
      const tab = store.getState().tabs.get(child.tabId)
      if (tab) {
        return { tabId: child.tabId, tab }
      }
    }
  }

  const targetId =
    msg.params.params && 'targetId' in msg.params.params && typeof msg.params.params.targetId === 'string'
      ? msg.params.params.targetId
      : undefined
  if (targetId) {
    return getTabByTargetId(targetId)
  }

  return undefined
}

async function handleCommand(msg: ExtensionCommandMessage): Promise<any> {
  if (msg.method !== 'forwardCDPCommand') return

  const resolved = getTabForCommand(msg)
  let targetTabId = resolved?.tabId
  let targetTab = resolved?.tab

  const debuggee = targetTabId ? { tabId: targetTabId } : undefined

  // Root-level Target.setAutoAttach must apply to all connected tabs since
  // CDP auto-attach is per-debugger-session. Without this, OOPIF targets never attach.
  if (msg.params.method === 'Target.setAutoAttach' && !msg.params.sessionId) {
    const params = msg.params.params as Protocol.Target.SetAutoAttachRequest | undefined
    if (!params) {
      return {}
    }

    autoAttachParams = params
    const connectedTabIds = Array.from(store.getState().tabs.entries())
      .filter(([_, info]) => info.state === 'connected')
      .map(([tabId]) => tabId)

    await Promise.all(
      connectedTabIds.map(async (tabId) => {
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', params)
        } catch (error) {
          logger.debug('Failed to set auto-attach for tab:', tabId, error)
        }
      }),
    )

    return {}
  }

  // TODO disable network things?
  // if (msg.params.method === 'Network.enable' && msg.params.source !== 'playwriter') {
  //   logger.debug('Skipping Network.enable from non-playwriter CDP client:', msg.params.sessionId)
  //   return {}
  // }

  switch (msg.params.method) {
    case 'Runtime.enable': {
      if (!debuggee) {
        throw new Error(`No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`)
      }
      // Keep Runtime.enable bound to the incoming child sessionId for OOPIF iframes.
      // If we send Runtime.enable on the tab root session, child iframe targets never
      // emit Runtime.executionContextCreated and frame locators can hang.
      const runtimeSession: chrome.debugger.DebuggerSession = {
        ...debuggee,
        sessionId: msg.params.sessionId !== targetTab?.sessionId ? msg.params.sessionId : undefined,
      }
      // When multiple Playwright clients connect to the same tab, each calls Runtime.enable.
      // If Runtime is already enabled, the enable call succeeds but Chrome doesn't re-send
      // Runtime.executionContextCreated events - those were already sent to the first client.
      // By disabling first, we force Chrome to re-send all execution context events when we
      // re-enable, ensuring the new client receives them. The relay server waits for the
      // executionContextCreated events before returning. See cdp-timing.md for details.
      try {
        await chrome.debugger.sendCommand(runtimeSession, 'Runtime.disable')
        await sleep(50)
      } catch (e) {
        logger.debug('Error disabling Runtime (ignoring):', e)
      }
      return await chrome.debugger.sendCommand(runtimeSession, 'Runtime.enable', msg.params.params)
    }

    case 'Target.createTarget': {
      const url = msg.params.params?.url || 'about:blank'
      logger.debug('Creating new tab with URL:', url)
      const tab = await chrome.tabs.create({ url, active: false })
      if (!tab.id) throw new Error('Failed to create tab')
      setTabConnecting(tab.id)
      logger.debug('Created tab:', tab.id, 'waiting for it to load...')
      await sleep(100)
      const { targetInfo } = await attachTab(tab.id, { shareSource: 'agent-created' })
      return { targetId: targetInfo.targetId } satisfies Protocol.Target.CreateTargetResponse
    }

    case 'Target.closeTarget': {
      if (!targetTabId) {
        logger.log(`Target not found: ${msg.params.params?.targetId}`)
        return { success: false } satisfies Protocol.Target.CloseTargetResponse
      }
      await chrome.tabs.remove(targetTabId)
      return { success: true } satisfies Protocol.Target.CloseTargetResponse
    }
  }

  if (!debuggee || !targetTab) {
    // Target.detachFromTarget is best-effort — no-op if the session is already gone (#40).
    if (msg.params.method === 'Target.detachFromTarget') {
      return {}
    }

    throw new Error(
      `No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId} params: ${JSON.stringify(msg.params.params || null)}`,
    )
  }

  logger.debug('CDP command:', msg.params.method, 'for tab:', targetTabId)

  const debuggerSession: chrome.debugger.DebuggerSession = {
    ...debuggee,
    sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : undefined,
  }

  return await chrome.debugger.sendCommand(debuggerSession, msg.params.method, msg.params.params)
}

function onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
  const tab = source.tabId ? store.getState().tabs.get(source.tabId) : undefined
  if (!tab) return

  logger.debug('Forwarding CDP event:', method, 'from tab:', source.tabId)

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    const targetUrl = params.targetInfo?.url as string | undefined
    // Filter out restricted child targets (other extensions' chrome-extension:// iframes,
    // chrome:// pages, devtools://, etc). Without this, Chrome's debugger API throws
    // "Cannot access a chrome-extension:// URL of a different extension" when the relay
    // tries to send commands (e.g. Runtime.runIfWaitingForDebugger) to these targets,
    // crashing the entire debugger session. See: https://github.com/remorses/playwriter/issues/18
    if (isRestrictedUrl(targetUrl)) {
      logger.debug(
        'Ignoring restricted child target:',
        targetUrl,
        'sessionId:',
        params.sessionId,
        'for tab:',
        source.tabId,
      )
      // Detach from the restricted child target to clean up. This command is sent on
      // the parent tab's debugger session (not the child), so it won't trigger the
      // restricted URL error.
      if (source.tabId) {
        chrome.debugger
          .sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: params.sessionId })
          .catch((e) => {
            logger.debug('Failed to detach restricted child target (expected):', e)
          })
      }
      return
    }

    logger.debug('Child target attached:', params.sessionId, 'for tab:', source.tabId)
    const targetId = params.targetInfo?.targetId as string | undefined
    childSessions.set(params.sessionId, { tabId: source.tabId!, targetId })
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    const mainTab = getTabBySessionId(params.sessionId)
    if (mainTab) {
      logger.debug('Main tab detached via CDP event:', mainTab.tabId, 'sessionId:', params.sessionId)
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.delete(mainTab.tabId)
        return { tabs: newTabs }
      })
      emitChildDetachesForTab(mainTab.tabId)
    } else {
      logger.debug('Child target detached:', params.sessionId)
      childSessions.delete(params.sessionId)
    }
  }

  sendMessage({
    method: 'forwardCDPEvent',
    params: {
      sessionId: source.sessionId || tab.sessionId,
      method,
      params,
    },
  })
}

function onDebuggerDetach(source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`): void {
  const tabId = source.tabId
  if (!tabId || !store.getState().tabs.has(tabId)) {
    logger.debug('Ignoring debugger detach event for untracked tab:', tabId)
    return
  }

  if (connectionManager.preserveTabsOnDetach) {
    logger.debug('Ignoring debugger detach during relay reconnect:', tabId, reason)
    return
  }

  logger.warn(`DISCONNECT: onDebuggerDetach tabId=${tabId} reason=${reason}`)

  const tab = store.getState().tabs.get(tabId)
  if (tab) {
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    })
  }

  emitChildDetachesForTab(tabId)

  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    newTabs.delete(tabId)
    return { tabs: newTabs }
  })

  if (reason === chrome.debugger.DetachReason.CANCELED_BY_USER) {
    // Chrome's debugger info bar cancellation detaches ALL debugger sessions, not just one tab
    store.setState({ connectionState: 'idle', errorText: undefined })
  }
}

type AttachTabResult = {
  targetInfo: Protocol.Target.TargetInfo
  sessionId: string
}

// Remove chrome-extension:// iframes from the page DOM before attaching the debugger.
// Chrome's chrome.debugger.attach API refuses to attach to tabs that contain frames from
// other extensions ("Cannot access a chrome-extension:// URL of different extension").
// Extensions like LastPass, SurfingKeys, etc. inject chrome-extension:// iframes into every
// page, breaking debugger attachment. This function temporarily removes them so the debugger
// can attach. The iframes stay removed while the debugger is active — they're typically
// re-injected by the owning extension on next page load.
// See: https://github.com/remorses/playwriter/issues/18
async function removeRestrictedIframes(tabId: number): Promise<number> {
  try {
    const results = await chrome.scripting.executeScript({
      // allFrames: true ensures we also scan same-origin subframes, not just the top document.
      target: { tabId, allFrames: true },
      func: (ownExtIds: string[]) => {
        // Traverse both the document and any open shadow roots, since some extensions
        // inject their chrome-extension:// iframes inside shadow DOM.
        const roots: ParentNode[] = [document]
        const elements = document.querySelectorAll('*')
        elements.forEach((el) => {
          const shadow = (el as HTMLElement).shadowRoot
          if (shadow) {
            roots.push(shadow)
          }
        })

        let removed = 0
        for (const root of roots) {
          root.querySelectorAll('iframe').forEach((iframe) => {
            const src = iframe.src || iframe.getAttribute('src') || ''
            if (!src.startsWith('chrome-extension://')) {
              return
            }
            const extId = src.replace('chrome-extension://', '').split('/')[0]
            if (ownExtIds.includes(extId)) {
              return
            }
            iframe.remove()
            removed++
          })
        }
        return removed
      },
      args: [OUR_EXTENSION_IDS],
    })
    const totalRemoved = results.reduce((sum, r) => sum + (r.result ?? 0), 0)
    if (totalRemoved > 0) {
      logger.debug(`Removed ${totalRemoved} restricted chrome-extension:// iframe(s) from tab:`, tabId)
    }
    return totalRemoved
  } catch (e) {
    // Scripting may fail on restricted pages (chrome://, about:, etc.) — that's fine,
    // those pages won't have extension iframes anyway.
    logger.debug('Could not remove restricted iframes (expected on some pages):', (e as Error).message)
    return 0
  }
}

async function attachTab(
  tabId: number,
  {
    skipAttachedEvent = false,
    shareSource = 'user',
  }: {
    skipAttachedEvent?: boolean
    shareSource?: TabShareSource
  } = {},
): Promise<AttachTabResult> {
  const debuggee = { tabId }
  let debuggerAttached = false

  try {
    logger.debug('Attaching debugger to tab:', tabId)

    // Bounded retry loop: chrome.debugger.attach fails if the tab contains chrome-extension://
    // iframes from other extensions. We remove them and retry, but aggressive extensions can
    // re-inject between cleanup and retry, so we allow up to 3 attempts.
    const maxAttachAttempts = 3
    for (let attempt = 1; attempt <= maxAttachAttempts; attempt++) {
      try {
        await chrome.debugger.attach(debuggee, '1.3')
        break
      } catch (attachError: any) {
        const msg = attachError.message ?? ''
        const isRestrictedIframeError = msg.includes('chrome-extension://') || msg.includes('different extension')
        if (!isRestrictedIframeError || attempt === maxAttachAttempts) {
          throw attachError
        }
        logger.debug(
          `Debugger attach blocked by chrome-extension:// iframe (attempt ${attempt}/${maxAttachAttempts}), removing and retrying:`,
          tabId,
        )
        await removeRestrictedIframes(tabId)
        await sleep(50)
      }
    }

    debuggerAttached = true
    logger.debug('Debugger attached successfully to tab:', tabId)

    await chrome.debugger.sendCommand(debuggee, 'Page.enable')

    // Reapply cached auto-attach for new tabs so OOPIF targets are reported immediately.
    if (autoAttachParams) {
      try {
        await chrome.debugger.sendCommand(debuggee, 'Target.setAutoAttach', autoAttachParams)
      } catch (error) {
        logger.debug('Failed to apply auto-attach for tab:', tabId, error)
      }
    }

    const contextMenuScript = `
      document.addEventListener('contextmenu', (e) => {
        window.__playwriter_lastRightClicked = e.target;
      }, true);
    `
    await chrome.debugger.sendCommand(debuggee, 'Page.addScriptToEvaluateOnNewDocument', { source: contextMenuScript })
    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: contextMenuScript })

    const result = (await chrome.debugger.sendCommand(
      debuggee,
      'Target.getTargetInfo',
    )) as Protocol.Target.GetTargetInfoResponse

    const targetInfo = {
      ...result.targetInfo,
      interpreterShareSource: shareSource,
    } as Protocol.Target.TargetInfo & { interpreterShareSource: TabShareSource }

    // Log error if URL is empty - this causes Playwright to create broken pages
    if (!targetInfo.url || targetInfo.url === '' || targetInfo.url === ':') {
      logger.error(
        'WARNING: Target.attachedToTarget will be sent with empty URL! tabId:',
        tabId,
        'targetInfo:',
        JSON.stringify(targetInfo),
      )
    }

    const attachOrder = nextSessionId
    const sessionId = `pw-tab-${tabSessionScope}-${nextSessionId++}`

    store.setState((state) => {
      const newTabs = new Map(state.tabs)
      newTabs.set(tabId, {
        sessionId,
        targetId: targetInfo.targetId,
        state: 'connected',
        attachOrder,
      })
      return { tabs: newTabs, connectionState: 'connected', errorText: undefined }
    })

    if (!skipAttachedEvent) {
      sendMessage({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    }

    logger.debug(
      'Tab attached successfully:',
      tabId,
      'sessionId:',
      sessionId,
      'targetId:',
      targetInfo.targetId,
      'url:',
      targetInfo.url,
      'skipAttachedEvent:',
      skipAttachedEvent,
    )
    return { targetInfo, sessionId }
  } catch (error) {
    // Clean up debugger if we attached but failed later
    if (debuggerAttached) {
      logger.debug('Cleaning up debugger after partial attach failure:', tabId)
      chrome.debugger.detach(debuggee).catch(() => {})
    }
    throw error
  }
}

function detachTab(tabId: number, shouldDetachDebugger: boolean): void {
  const tab = store.getState().tabs.get(tabId)
  if (!tab) {
    logger.debug('detachTab: tab not found in map:', tabId)
    return
  }

  logger.warn(`DISCONNECT: detachTab tabId=${tabId} shouldDetach=${shouldDetachDebugger} stack=${getCallStack()}`)

  // Only send detach event if tab was fully attached (has sessionId/targetId)
  // Tabs in 'connecting' state may not have these yet
  if (tab.sessionId && tab.targetId) {
    sendMessage({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    })
  }

  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    newTabs.delete(tabId)
    return { tabs: newTabs }
  })

  emitChildDetachesForTab(tabId)

  if (shouldDetachDebugger) {
    chrome.debugger.detach({ tabId }).catch((err) => {
      logger.debug('Error detaching debugger from tab:', tabId, err.message)
    })
  }
}

async function connectTab(tabId: number): Promise<void> {
  try {
    logger.debug(`Starting connection to tab ${tabId}`)

    setTabConnecting(tabId)

    await connectionManager.ensureConnection()
    await attachTab(tabId)

    logger.debug(`Successfully connected to tab ${tabId}`)
  } catch (error: any) {
    logger.debug(`Failed to connect to tab ${tabId}:`, error)

    // Distinguish between WS connection errors and tab-specific errors
    // WS errors: keep in 'connecting' state, maintainLoop will retry when WS is available
    // Tab errors: show 'error' state (e.g., restricted page, debugger attach failed)
    // Extension in use: set global 'extension-replaced' state to enter polling mode
    const isExtensionInUse =
      error.message === 'Extension Already In Use' ||
      error.message === 'Another Bolt Chrome Extension is already connected'

    const isWsError =
      error.message === 'Server not available' ||
      error.message === 'Connection timeout' ||
      error.message.startsWith('WebSocket')

    if (isExtensionInUse) {
      logger.debug(`Another extension is in use, entering polling mode`)
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.delete(tabId)
        return {
          tabs: newTabs,
          connectionState: 'extension-replaced',
          errorText: 'Another Bolt Chrome Extension is actively in use',
        }
      })
    } else if (isWsError) {
      logger.debug(`WS connection failed, keeping tab ${tabId} in connecting state for retry`)
      // Tab stays in 'connecting' state - maintainLoop will retry when WS becomes available
    } else {
      store.setState((state) => {
        const newTabs = new Map(state.tabs)
        newTabs.set(tabId, { state: 'error', errorText: `Error: ${error.message}` })
        return { tabs: newTabs }
      })
    }
  }
}

function setTabConnecting(tabId: number): void {
  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    const existing = newTabs.get(tabId)
    newTabs.set(tabId, { ...existing, state: 'connecting' })
    return { tabs: newTabs }
  })
}

async function disconnectTab(tabId: number): Promise<void> {
  logger.debug(`Disconnecting tab ${tabId}`)

  const { tabs } = store.getState()
  if (!tabs.has(tabId)) {
    logger.debug('Tab not in tabs map, ignoring disconnect')
    return
  }

  detachTab(tabId, true)
  // WS connection is maintained even with no tabs - maintainConnection handles it
}

async function toggleExtensionForActiveTab(): Promise<{ isConnected: boolean; state: ExtensionState }> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab?.id) throw new Error('No active tab found')

  await onActionClicked(tab)

  await new Promise<void>((resolve) => {
    const check = () => {
      const state = store.getState()
      const tabInfo = state.tabs.get(tab.id!)
      if (tabInfo?.state === 'connecting') {
        setTimeout(check, 100)
        return
      }
      resolve()
    }
    check()
  })

  const state = store.getState()
  const isConnected = state.tabs.has(tab.id) && state.tabs.get(tab.id)?.state === 'connected'
  return { isConnected, state }
}

async function disconnectEverything(): Promise<void> {
  const { tabs } = store.getState()
  for (const tabId of tabs.keys()) {
    await disconnectTab(tabId)
  }
  // WS connection is maintained - maintainConnection handles it
}

async function resetDebugger(): Promise<void> {
  let targets = await chrome.debugger.getTargets()
  targets = targets.filter((x) => x.tabId && x.attached)
  logger.log(`found ${targets.length} existing debugger targets. detaching them before background script starts`)
  for (const target of targets) {
    await chrome.debugger.detach({ tabId: target.tabId })
  }
}

// Our extension IDs - allow attaching to our own extension pages for debugging
const OUR_EXTENSION_IDS = [
  'ndndcckllfokpejkgnecbjpaplbbgmip', // Bolt production extension (Chrome Web Store)
  'bboaaphdpllilofamfpommlbafpellnb', // Interpreter production extension (legacy, kept for transition)
  'pebbngnfojnignonigcnkdilknapkgid', // Dev extension (stable ID from manifest key)
]

// undefined URL is for about:blank pages (not restricted) and chrome:// URLs (restricted).
// We can't distinguish them without the `tabs` permission, so we just let attachment fail.
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false

  // Allow our own extension pages, block all other extensions
  if (url.startsWith('chrome-extension://')) {
    const extensionId = url.replace('chrome-extension://', '').split('/')[0]
    return !OUR_EXTENSION_IDS.includes(extensionId)
  }

  const restrictedPrefixes = [
    'chrome://',
    'devtools://',
    'edge://',
    'https://chrome.google.com/',
    'https://chromewebstore.google.com/',
  ]
  return restrictedPrefixes.some((prefix) => url.startsWith(prefix))
}

const icons = {
  connected: {
    path: {
      '16': '/icons/icon-green-16.png',
      '32': '/icons/icon-green-32.png',
      '48': '/icons/icon-green-48.png',
      '128': '/icons/icon-green-128.png',
    },
    title: 'This tab is connected to Bolt - Click to disconnect',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  relayUnavailable: {
    path: {
      '16': '/icons/icon-gray-16.png',
      '32': '/icons/icon-gray-32.png',
      '48': '/icons/icon-gray-48.png',
      '128': '/icons/icon-gray-128.png',
    },
    title: 'Waiting for the local Bolt relay. Start the app, then try again.',
    badgeText: '...',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  connecting: {
    path: {
      '16': '/icons/icon-blue-16.png',
      '32': '/icons/icon-blue-32.png',
      '48': '/icons/icon-blue-48.png',
      '128': '/icons/icon-blue-128.png',
    },
    title: 'Connecting this tab to Bolt...',
    badgeText: '...',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  idle: {
    path: {
      '16': '/icons/icon-black-16.png',
      '32': '/icons/icon-black-32.png',
      '48': '/icons/icon-black-48.png',
      '128': '/icons/icon-black-128.png',
    },
    title: 'Bolt is ready. Click to connect this tab.',
    badgeText: '',
    badgeColor: [64, 64, 64, 255] as [number, number, number, number],
  },
  restricted: {
    path: {
      '16': '/icons/icon-red-16.png',
      '32': '/icons/icon-red-32.png',
      '48': '/icons/icon-red-48.png',
      '128': '/icons/icon-red-128.png',
    },
    title: 'Chrome blocks this page. Open a normal site, then click the extension there.',
    badgeText: '!',
    badgeColor: [220, 38, 38, 255] as [number, number, number, number],
  },
  extensionReplaced: {
    path: {
      '16': '/icons/icon-red-16.png',
      '32': '/icons/icon-red-32.png',
      '48': '/icons/icon-red-48.png',
      '128': '/icons/icon-red-128.png',
    },
    title: 'Another Bolt Chrome Extension connected - Click to retry',
    badgeText: '!',
    badgeColor: [220, 38, 38, 255] as [number, number, number, number],
  },
  tabError: {
    path: {
      '16': '/icons/icon-red-16.png',
      '32': '/icons/icon-red-32.png',
      '48': '/icons/icon-red-48.png',
      '128': '/icons/icon-red-128.png',
    },
    title: 'Error',
    badgeText: '!',
    badgeColor: [220, 38, 38, 255] as [number, number, number, number],
  },
} as const

async function updateIcons(): Promise<void> {
  const state = store.getState()
  const { connectionState, tabs, errorText } = state

  const connectedCount = Array.from(tabs.values()).filter((t) => t.state === 'connected').length

  const allTabs = await chrome.tabs.query({})
  const tabUrlMap = new Map(allTabs.map((tab) => [tab.id, tab.url]))
  const allTabIds = [undefined, ...allTabs.map((tab) => tab.id).filter((id): id is number => id !== undefined)]

  for (const tabId of allTabIds) {
    const tabInfo = tabId !== undefined ? tabs.get(tabId) : undefined
    const tabUrl = tabId !== undefined ? tabUrlMap.get(tabId) : undefined

    const iconConfig = (() => {
      if (connectionState === 'extension-replaced') return icons.extensionReplaced
      if (tabId !== undefined && isRestrictedUrl(tabUrl)) return icons.restricted
      if (tabInfo?.state === 'error') return icons.tabError
      if (tabInfo?.state === 'connecting') return icons.connecting
      if (tabInfo?.state === 'connected') return icons.connected
      if (connectionState !== 'connected') return icons.relayUnavailable
      return icons.idle
    })()

    const title = (() => {
      if (connectionState === 'extension-replaced' && errorText) return errorText
      if (tabInfo?.errorText) return tabInfo.errorText
      return iconConfig.title
    })()

    const badgeText = (() => {
      if (
        iconConfig === icons.connected ||
        iconConfig === icons.idle ||
        iconConfig === icons.restricted
      ) {
        return connectedCount > 0 ? String(connectedCount) : ''
      }
      return iconConfig.badgeText
    })()

    void chrome.action.setIcon({ tabId, path: iconConfig.path })
    void chrome.action.setTitle({ tabId, title })
    if (iconConfig.badgeColor) void chrome.action.setBadgeBackgroundColor({ tabId, color: iconConfig.badgeColor })
    void chrome.action.setBadgeText({ tabId, text: badgeText })
  }
}

async function onTabRemoved(tabId: number): Promise<void> {
  const { tabs } = store.getState()
  if (!tabs.has(tabId)) return
  logger.debug(`Connected tab ${tabId} was closed, disconnecting`)
  await disconnectTab(tabId)
}

async function onTabActivated(activeInfo: chrome.tabs.TabActiveInfo): Promise<void> {
  store.setState({ currentTabId: activeInfo.tabId })
  // Use the authoritative tab id from the event (not a query, which can race and
  // return the tab being left — causing a one-switch lag in the placeholder).
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId)
    void pushTab(tab)
  } catch {
    // tab may have been closed; ignore
  }
}

async function onActionClicked(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) {
    logger.debug('No tab ID available')
    return
  }

  if (isRestrictedUrl(tab.url)) {
    logger.debug('Cannot attach to restricted URL:', tab.url)
    return
  }

  const { tabs, connectionState } = store.getState()
  const tabInfo = tabs.get(tab.id)

  // If another Playwriter extension took over, clear error state and try to reconnect this tab
  if (connectionState === 'extension-replaced') {
    logger.debug('Clearing extension-replaced state, attempting to reconnect')
    store.setState({ connectionState: 'idle', errorText: undefined })
    summonOverlay(tab)
    await connectTab(tab.id)
    return
  }

  if (tabInfo?.state === 'error') {
    logger.debug('Tab has error - disconnecting to clear state')
    await disconnectTab(tab.id)
    return
  }

  if (tabInfo?.state === 'connecting') {
    logger.debug('Tab is already connecting, ignoring click')
    return
  }

  if (tabInfo?.state === 'connected') {
    await disconnectTab(tab.id)
  } else {
    summonOverlay(tab)
    await connectTab(tab.id)
  }
}

resetDebugger()
connectionManager.maintainLoop()

chrome.contextMenus
  .remove('playwriter-pin-element')
  .catch(() => {})
  .finally(() => {
    chrome.contextMenus?.create({
      id: 'playwriter-pin-element',
      title: 'Copy Bolt Element Reference',
      contexts: ['all'],
      visible: false,
    })
  })

function updateContextMenuVisibility(): void {
  const { currentTabId, tabs } = store.getState()
  const isConnected = currentTabId !== undefined && tabs.get(currentTabId)?.state === 'connected'
  chrome.contextMenus?.update('playwriter-pin-element', { visible: isConnected })
}

chrome.runtime.onInstalled.addListener((details) => {
  if (import.meta.env.TESTING) return
  if (!__PLAYWRITER_OPEN_WELCOME_PAGE__) return
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: 'src/welcome.html' })
  }
})

store.subscribe((state) => {
  logger.log(state)
  void updateIcons()
  updateContextMenuVisibility()
})

logger.debug(`Using relay host: ${RELAY_HOST}, port: ${RELAY_PORT}`)

// Memory monitoring - helps debug service worker termination issues
let lastMemoryUsage = 0
let lastMemoryCheck = Date.now()
const MEMORY_WARNING_THRESHOLD = 50 * 1024 * 1024 // 50MB
const MEMORY_CRITICAL_THRESHOLD = 100 * 1024 * 1024 // 100MB
const MEMORY_GROWTH_THRESHOLD = 10 * 1024 * 1024 // 10MB growth per interval is suspicious

function checkMemory(): void {
  try {
    // @ts-ignore - performance.memory is Chrome-specific and not in TS types
    const memory = performance.memory
    if (!memory) {
      return
    }

    const used = memory.usedJSHeapSize
    const total = memory.totalJSHeapSize
    const limit = memory.jsHeapSizeLimit
    const now = Date.now()
    const timeDelta = now - lastMemoryCheck
    const memoryDelta = used - lastMemoryUsage

    const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + 'MB'
    const growthRate = timeDelta > 0 ? (memoryDelta / timeDelta) * 1000 : 0 // bytes per second

    // Log if memory is high or growing rapidly
    if (used > MEMORY_CRITICAL_THRESHOLD) {
      logger.error(
        `MEMORY CRITICAL: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`,
      )
    } else if (used > MEMORY_WARNING_THRESHOLD) {
      logger.warn(
        `MEMORY WARNING: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`,
      )
    } else if (memoryDelta > MEMORY_GROWTH_THRESHOLD && timeDelta < 60000) {
      logger.warn(
        `MEMORY SPIKE: grew ${formatMB(memoryDelta)} in ${(timeDelta / 1000).toFixed(1)}s (used=${formatMB(used)})`,
      )
    }

    lastMemoryUsage = used
    lastMemoryCheck = now
  } catch (e) {
    // Silently ignore - performance.memory may not be available
  }
}

// Check memory every 5 seconds
setInterval(checkMemory, 5000)

// Initial memory check
checkMemory()

chrome.tabs.onRemoved.addListener(onTabRemoved)
chrome.tabs.onActivated.addListener(onTabActivated)
chrome.action.onClicked.addListener(onActionClicked)
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  void updateIcons()
  // Keep the overlay placeholder current when the active tab's title/url changes.
  // Use the tab object the event provides (authoritative, no query race).
  if (tab?.active && (changeInfo.title !== undefined || changeInfo.url !== undefined)) {
    void pushTab(tab)
  }
})
chrome.windows.onFocusChanged.addListener(() => {
  // Switching windows (or back to Chrome) changes the focused active tab.
  void pushActiveTabNow()
})

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'playwriter-pin-element' || !tab?.id) return

  const tabInfo = store.getState().tabs.get(tab.id)
  if (!tabInfo || tabInfo.state !== 'connected') {
    logger.debug('Tab not connected, ignoring')
    return
  }

  const debuggee = { tabId: tab.id }
  const count = (tabInfo.pinnedCount || 0) + 1

  store.setState((state) => {
    const newTabs = new Map(state.tabs)
    const existing = newTabs.get(tab.id!)
    if (existing) {
      newTabs.set(tab.id!, { ...existing, pinnedCount: count })
    }
    return { tabs: newTabs }
  })

  const name = `playwriterPinnedElem${count}`

  const connectedTabs = Array.from(store.getState().tabs.entries())
    .filter(([_, t]) => t.state === 'connected')
    .sort((a, b) => (a[1].attachOrder ?? 0) - (b[1].attachOrder ?? 0))
  const pageIndex = connectedTabs.findIndex(([id]) => id === tab.id)
  const hasMultiplePages = connectedTabs.length > 1

  try {
    const result = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: `
        if (window.__playwriter_lastRightClicked) {
          window.${name} = window.__playwriter_lastRightClicked;
          '${name}';
        } else {
          throw new Error('No element was right-clicked');
        }
      `,
      returnByValue: true,
    })) as { result?: { value?: string }; exceptionDetails?: { text: string } }

    if (result.exceptionDetails) {
      logger.error('Failed to pin element:', result.exceptionDetails.text)
      return
    }

    const clipboardText = hasMultiplePages
      ? `globalThis.${name} (page ${pageIndex}, ${tab.url || 'unknown url'})`
      : `globalThis.${name}`

    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: `
        (() => {
          const el = window.${name};
          if (!el) return;
          const orig = el.getAttribute('style') || '';
          el.setAttribute('style', orig + '; outline: 3px solid #22c55e !important; outline-offset: 2px !important; box-shadow: 0 0 0 3px #22c55e !important;');
          setTimeout(() => el.setAttribute('style', orig), 300);
          return navigator.clipboard.writeText(${JSON.stringify(clipboardText)});
        })()
      `,
      awaitPromise: true,
    })

    logger.debug('Pinned element as:', name)
  } catch (error: any) {
    logger.error('Failed to pin element:', error.message)
  }
})

// Sync icons on first load
void updateIcons()
