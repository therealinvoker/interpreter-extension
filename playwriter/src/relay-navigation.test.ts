import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Page } from '@xmorse/playwright-core'
import WebSocket from 'ws'
import path from 'node:path'
import { getCdpUrl } from './utils.js'
import {
  setupTestContext,
  cleanupTestContext,
  getExtensionServiceWorker,
  type TestContext,
  withTimeout,
  createSimpleServer,
  safeCloseCDPBrowser,
} from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = 19992
const NO_POLICY_TEST_PORT = 19993
const MATRIX_POLICY_TEST_PORT = 19994
const FIXTURE_EXTENSION_PATH = path.resolve('../extension/test-fixtures/fixture-extension')

describe('Relay Navigation Tests', () => {
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({
      port: TEST_PORT,
      tempDirPrefix: 'pw-nav-test-',
      toggleExtension: true,
      additionalExtensions: [FIXTURE_EXTENSION_PATH],
    })
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx)
    testCtx = null
  })

  const getBrowserContext = () => {
    if (!testCtx?.browserContext) throw new Error('Browser not initialized')
    return testCtx.browserContext
  }

  const waitForStableDocumentReadyState = async ({ page, timeoutMs }: { page: Page; timeoutMs: number }) => {
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      try {
        const readyState = await page.evaluate(() => {
          return document.readyState
        })
        if (readyState !== 'loading') {
          return
        }
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes('Execution context was destroyed')) {
          throw new Error('Failed while waiting for stable document readyState', { cause: e })
        }
      }

      await page.waitForTimeout(100)
    }

    throw new Error(`Timed out waiting for stable document readyState after ${timeoutMs}ms`)
  }

  it('should be usable after toggle with valid URL', async () => {
    // Validates the extension waits for a non-empty URL before attaching.

    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const context = browser.contexts()[0]

    const server = await createSimpleServer({
      routes: {
        '/': '<!doctype html><html><body>ok</body></html>',
      },
    })

    const page = await browserContext.newPage()
    try {
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      const pagePromise = context.waitForEvent('page', { timeout: 5000 })

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const targetPage = await pagePromise
      console.log('Page URL when event fired:', targetPage.url())

      expect(targetPage.url()).not.toBe('')
      expect(targetPage.url()).not.toBe(':')
      expect(targetPage.url()).toContain(server.baseUrl)

      const result = await targetPage.evaluate(() => window.location.href)
      expect(result).toContain(server.baseUrl)
    } finally {
      await browser.close()
      await page.close()
      await server.close()
    }
  }, 15000)

  it('should keep toggled pages out of controllable targets when no app policy is supplied', async () => {
    let noPolicyCtx: TestContext | null = null
    const server = await createSimpleServer({
      routes: {
        '/': '<!doctype html><html><body>blocked until policy</body></html>',
      },
    })

    try {
      noPolicyCtx = await setupTestContext({
        port: NO_POLICY_TEST_PORT,
        tempDirPrefix: 'pw-nav-no-policy-test-',
        accessPolicy: null,
      })
      const serviceWorker = await getExtensionServiceWorker(noPolicyCtx.browserContext)
      const page = await noPolicyCtx.browserContext.newPage()
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const statusRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/status`)
      expect(statusRes.status).toBe(200)
      const statusJson = await statusRes.json() as {
        activeTargets: number
        targets: Array<{ url: string }>
        browserTabs: { windows: Array<{ tabs: Array<{ url: string; controlState: 'observable' | 'controllable'; shared: boolean }> }> }
      }
      const inventoryTabs = statusJson.browserTabs.windows.flatMap((window) => window.tabs)
      expect(statusJson.activeTargets).toBe(0)
      expect(statusJson.targets).toEqual([])
      expect(inventoryTabs.some((tab) => tab.url.startsWith(server.baseUrl))).toBe(false)

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extensions/status`)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string; active?: boolean }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions[0]
      const blockedTab = await serviceWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
        const tab = tabs[0]
        return tab?.id ? { chromeTabId: tab.id, url: tab.url || '' } : null
      })
      expect(extension).toBeDefined()
      expect(blockedTab).toBeDefined()

      const pageElementsRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/page-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
        }),
      })
      expect(pageElementsRes.status).toBe(403)
      await expect(pageElementsRes.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Interpreter browser settings blocked this request'),
      })

      const pageTraceRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/page-trace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
          bounds: { x: 10, y: 10, width: 20, height: 20 },
        }),
      })
      expect(pageTraceRes.status).toBe(403)
      await expect(pageTraceRes.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Interpreter browser settings blocked this request'),
      })

      const pageClickRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/page-click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
          refId: 'browser-element:blocked:0',
        }),
      })
      expect(pageClickRes.status).toBe(403)
      await expect(pageClickRes.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Interpreter browser settings blocked this request'),
      })

      const pageTypeRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/page-type`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
          refId: 'browser-element:blocked:0',
          text: 'blocked',
        }),
      })
      expect(pageTypeRes.status).toBe(403)
      await expect(pageTypeRes.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Interpreter browser settings blocked this request'),
      })

      const pageSelectRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/page-select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
          refId: 'browser-element:blocked:0',
          value: 'blocked',
        }),
      })
      expect(pageSelectRes.status).toBe(403)
      await expect(pageSelectRes.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Interpreter browser settings blocked this request'),
      })

      const pageScrollRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/page-scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
          deltaY: 200,
        }),
      })
      expect(pageScrollRes.status).toBe(403)
      await expect(pageScrollRes.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Interpreter browser settings blocked this request'),
      })

      const activateTabRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/activate-tab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
        }),
      })
      expect(activateTabRes.status).toBe(200)
      await expect(activateTabRes.json()).resolves.toMatchObject({ success: true })

      const claimTabRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extension/claim-tab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: blockedTab!.chromeTabId,
        }),
      })
      expect(claimTabRes.status).toBe(403)
      await expect(claimTabRes.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Interpreter browser settings blocked this request'),
      })
    } finally {
      await cleanupTestContext(noPolicyCtx)
      await server.close()
    }
  }, 60000)

  it('should enforce read write and action browser policy classes separately', async () => {
    let matrixCtx: TestContext | null = null
    const server = await createSimpleServer({
      routes: {
        '/': `<!doctype html>
          <html>
            <body>
              <button id="run">Run</button>
              <input id="name" aria-label="Name">
              <select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>
            </body>
          </html>`,
      },
    })

    try {
      matrixCtx = await setupTestContext({
        port: MATRIX_POLICY_TEST_PORT,
        tempDirPrefix: 'pw-nav-matrix-policy-test-',
        accessPolicy: {
          permissions: {
            read: { mode: 'all', allowedPatterns: [] },
            write: { mode: 'deny', allowedPatterns: [] },
            action: { mode: 'deny', allowedPatterns: [] },
          },
          profilePolicies: [],
        },
      })
      const serviceWorker = await getExtensionServiceWorker(matrixCtx.browserContext)
      const page = await matrixCtx.browserContext.newPage()
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${MATRIX_POLICY_TEST_PORT}/extensions/status`)
      expect(extensionsStatusRes.status).toBe(200)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions.find((candidate) => {
        return (candidate.browserTabs?.windows ?? []).some((window) => (
          (window.tabs ?? []).some((tab) => tab.url.startsWith(server.baseUrl))
        ))
      })
      const readableTab = extension?.browserTabs?.windows
        ?.flatMap((window) => window.tabs ?? [])
        .find((tab) => tab.url.startsWith(server.baseUrl))
      expect(extension).toBeDefined()
      expect(readableTab).toBeDefined()

      const pageElementsRes = await fetch(`http://127.0.0.1:${MATRIX_POLICY_TEST_PORT}/extension/page-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: readableTab!.chromeTabId,
        }),
      })
      expect(pageElementsRes.status).toBe(200)
      await expect(pageElementsRes.json()).resolves.toMatchObject({ success: true })

      const activateTabRes = await fetch(`http://127.0.0.1:${MATRIX_POLICY_TEST_PORT}/extension/activate-tab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: readableTab!.chromeTabId,
        }),
      })
      expect(activateTabRes.status).toBe(200)
      await expect(activateTabRes.json()).resolves.toMatchObject({ success: true })

      for (const endpoint of ['page-trace', 'page-click', 'page-scroll', 'claim-tab']) {
        const body = endpoint === 'page-trace'
          ? { chromeTabId: readableTab!.chromeTabId, bounds: { x: 10, y: 10, width: 20, height: 20 } }
          : endpoint === 'page-click'
            ? { chromeTabId: readableTab!.chromeTabId, refId: 'browser-element:blocked:0' }
            : endpoint === 'page-scroll'
              ? { chromeTabId: readableTab!.chromeTabId, deltaY: 200 }
              : { chromeTabId: readableTab!.chromeTabId }
        const res = await fetch(`http://127.0.0.1:${MATRIX_POLICY_TEST_PORT}/extension/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            extensionId: extension!.stableKey || extension!.extensionId,
            ...body,
          }),
        })
        expect(res.status, endpoint).toBe(403)
        await expect(res.json()).resolves.toMatchObject({
          success: false,
          error: expect.stringContaining('Interpreter browser settings blocked this request'),
        })
      }

      for (const endpoint of ['page-type', 'page-select']) {
        const res = await fetch(`http://127.0.0.1:${MATRIX_POLICY_TEST_PORT}/extension/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            extensionId: extension!.stableKey || extension!.extensionId,
            chromeTabId: readableTab!.chromeTabId,
            refId: 'browser-element:blocked:0',
            ...(endpoint === 'page-type' ? { text: 'blocked' } : { value: 'b' }),
          }),
        })
        expect(res.status, endpoint).toBe(403)
        await expect(res.json()).resolves.toMatchObject({
          success: false,
          error: expect.stringContaining('Interpreter browser settings blocked this request'),
        })
      }
    } finally {
      await cleanupTestContext(matrixCtx)
      await server.close()
    }
  }, 60000)

  it('should type into editable page element refs through the extension relay', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({
      routes: {
        '/type-target': `<!doctype html>
          <html>
            <body>
              <label for="name">Name</label>
              <input id="name" aria-label="Full name" value="">
              <div id="events">input:0 change:0</div>
              <script>
                let inputCount = 0;
                let changeCount = 0;
                const nameInput = document.getElementById('name');
                const events = document.getElementById('events');
                function render() {
                  document.body.setAttribute('data-input-count', String(inputCount));
                  document.body.setAttribute('data-change-count', String(changeCount));
                  events.textContent = 'input:' + inputCount + ' change:' + changeCount;
                }
                nameInput.addEventListener('input', () => {
                  inputCount += 1;
                  document.body.setAttribute('data-last-input-value', nameInput.value);
                  render();
                });
                nameInput.addEventListener('change', () => {
                  changeCount += 1;
                  document.body.setAttribute('data-last-change-value', nameInput.value);
                  render();
                });
                render();
              </script>
            </body>
          </html>`,
      },
    })
    const page = await browserContext.newPage()

    try {
      await page.goto(`${server.baseUrl}/type-target`, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
      expect(extensionsStatusRes.status).toBe(200)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string; active?: boolean }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions.find((candidate) => {
        return (candidate.browserTabs?.windows ?? []).some((window) => {
          return (window.tabs ?? []).some((tab) => tab.url === `${server.baseUrl}/type-target`)
        })
      })
      const browserTab = extension?.browserTabs?.windows
        ?.flatMap((window) => window.tabs ?? [])
        .find((tab) => tab.url === `${server.baseUrl}/type-target`)
      expect(extension).toBeDefined()
      expect(browserTab).toBeDefined()

      const elementInventoryRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          maxElements: 10,
        }),
      })
      expect(elementInventoryRes.status).toBe(200)
      const elementInventoryJson = await elementInventoryRes.json() as {
        success: boolean
        frames: Array<{
          frameId: number
          elements: Array<{
            refId: string
            name: string
            value: string | null
            editable: boolean
            bounds: { x: number; y: number; width: number; height: number }
          }>
        }>
      }
      expect(elementInventoryJson.success).toBe(true)
      const frame = elementInventoryJson.frames[0]
      const input = frame.elements.find((element) => {
        return element.name === 'Full name' && element.editable === true
      })
      expect(input).toBeDefined()

      const typeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-type`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: frame.frameId,
          refId: input!.refId,
          text: 'Ada Lovelace',
          durationMs: 3_000,
        }),
      })
      expect(typeRes.status).toBe(200)
      await expect(typeRes.json()).resolves.toMatchObject({
        success: true,
        chromeTabId: browserTab!.chromeTabId,
        frameId: frame.frameId,
        refId: input!.refId,
        value: 'Ada Lovelace',
        bounds: input!.bounds,
      })
      await expect.poll(() => {
        return page.locator('#name').inputValue()
      }).toBe('Ada Lovelace')
      await expect.poll(async () => {
        return page.evaluate(() => ({
          inputCount: document.body.getAttribute('data-input-count'),
          changeCount: document.body.getAttribute('data-change-count'),
          lastInputValue: document.body.getAttribute('data-last-input-value'),
          lastChangeValue: document.body.getAttribute('data-last-change-value'),
        }))
      }).toEqual({
        inputCount: '1',
        changeCount: '1',
        lastInputValue: 'Ada Lovelace',
        lastChangeValue: 'Ada Lovelace',
      })
      await page.waitForFunction(() => {
        return Boolean(document.getElementById('interpreter-browser-control-trace'))
      }, null, { timeout: 5000 })

      const staleTypeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-type`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: frame.frameId,
          refId: input!.refId,
          text: 'Grace Hopper',
        }),
      })
      expect(staleTypeRes.status).toBe(400)
      await expect(staleTypeRes.json()).resolves.toMatchObject({
        success: false,
        error: 'refId is stale or not visible',
      })
    } finally {
      await page.close()
      await server.close()
    }
  }, 60000)

  it('should expose selected page text through page element inventory', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({
      routes: {
        '/selection-target': `<!doctype html>
          <html>
            <body>
              <p id="source">Alpha selected browser text omega</p>
              <button>Keep inventory non-empty</button>
            </body>
          </html>`,
      },
    })
    const page = await browserContext.newPage()

    try {
      await page.goto(`${server.baseUrl}/selection-target`, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()
      await page.evaluate(() => {
        const source = document.getElementById('source')
        if (!source) throw new Error('source missing')
        const range = document.createRange()
        range.selectNodeContents(source)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
      expect(extensionsStatusRes.status).toBe(200)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions.find((candidate) => {
        return (candidate.browserTabs?.windows ?? []).some((window) => {
          return (window.tabs ?? []).some((tab) => tab.url === `${server.baseUrl}/selection-target`)
        })
      })
      const browserTab = extension?.browserTabs?.windows
        ?.flatMap((window) => window.tabs ?? [])
        .find((tab) => tab.url === `${server.baseUrl}/selection-target`)
      expect(extension).toBeDefined()
      expect(browserTab).toBeDefined()

      const elementInventoryRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          maxElements: 10,
        }),
      })
      expect(elementInventoryRes.status).toBe(200)
      const elementInventoryJson = await elementInventoryRes.json() as {
        success: boolean
        frames: Array<{ selectionText?: string }>
      }
      expect(elementInventoryJson.success).toBe(true)
      expect(elementInventoryJson.frames.some((frame) => frame.selectionText === 'Alpha selected browser text omega')).toBe(true)
    } finally {
      await page.close()
      await server.close()
    }
  }, 15000)

  it('should select page element options through the extension relay', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({
      routes: {
        '/select-target': `<!doctype html>
          <html>
            <body>
              <label for="team">Team</label>
              <select id="team" aria-label="Team">
                <option value="">Choose one</option>
                <option value="operations">Operations</option>
                <option value="support">Support</option>
              </select>
              <div id="events">input:0 change:0</div>
              <script>
                let inputCount = 0;
                let changeCount = 0;
                const teamSelect = document.getElementById('team');
                const events = document.getElementById('events');
                function render() {
                  document.body.setAttribute('data-input-count', String(inputCount));
                  document.body.setAttribute('data-change-count', String(changeCount));
                  events.textContent = 'input:' + inputCount + ' change:' + changeCount;
                }
                teamSelect.addEventListener('input', () => {
                  inputCount += 1;
                  document.body.setAttribute('data-last-input-value', teamSelect.value);
                  render();
                });
                teamSelect.addEventListener('change', () => {
                  changeCount += 1;
                  document.body.setAttribute('data-last-change-value', teamSelect.value);
                  render();
                });
                render();
              </script>
            </body>
          </html>`,
      },
    })
    const page = await browserContext.newPage()

    try {
      await page.goto(`${server.baseUrl}/select-target`, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
      expect(extensionsStatusRes.status).toBe(200)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string; active?: boolean }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions.find((candidate) => {
        return (candidate.browserTabs?.windows ?? []).some((window) => {
          return (window.tabs ?? []).some((tab) => tab.url === `${server.baseUrl}/select-target`)
        })
      })
      const browserTab = extension?.browserTabs?.windows
        ?.flatMap((window) => window.tabs ?? [])
        .find((tab) => tab.url === `${server.baseUrl}/select-target`)
      expect(extension).toBeDefined()
      expect(browserTab).toBeDefined()

      const elementInventoryRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          maxElements: 10,
        }),
      })
      expect(elementInventoryRes.status).toBe(200)
      const elementInventoryJson = await elementInventoryRes.json() as {
        success: boolean
        frames: Array<{
          frameId: number
          elements: Array<{
            refId: string
            name: string
            value: string | null
            tagName: string
            bounds: { x: number; y: number; width: number; height: number }
          }>
        }>
      }
      expect(elementInventoryJson.success).toBe(true)
      const frame = elementInventoryJson.frames[0]
      const select = frame.elements.find((element) => {
        return element.name === 'Team' && element.tagName === 'select'
      })
      expect(select).toBeDefined()

      const selectRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: frame.frameId,
          refId: select!.refId,
          value: 'operations',
          durationMs: 3_000,
        }),
      })
      expect(selectRes.status).toBe(200)
      await expect(selectRes.json()).resolves.toMatchObject({
        success: true,
        chromeTabId: browserTab!.chromeTabId,
        frameId: frame.frameId,
        refId: select!.refId,
        value: 'operations',
        bounds: select!.bounds,
      })
      await expect.poll(() => {
        return page.locator('#team').inputValue()
      }).toBe('operations')
      await expect.poll(async () => {
        return page.evaluate(() => ({
          inputCount: document.body.getAttribute('data-input-count'),
          changeCount: document.body.getAttribute('data-change-count'),
          lastInputValue: document.body.getAttribute('data-last-input-value'),
          lastChangeValue: document.body.getAttribute('data-last-change-value'),
        }))
      }).toEqual({
        inputCount: '1',
        changeCount: '1',
        lastInputValue: 'operations',
        lastChangeValue: 'operations',
      })
      await page.waitForFunction(() => {
        return Boolean(document.getElementById('interpreter-browser-control-trace'))
      }, null, { timeout: 5000 })

      const staleSelectRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: frame.frameId,
          refId: select!.refId,
          value: 'support',
        }),
      })
      expect(staleSelectRes.status).toBe(400)
      await expect(staleSelectRes.json()).resolves.toMatchObject({
        success: false,
        error: 'refId is stale or not visible',
      })
    } finally {
      await page.close()
      await server.close()
    }
  }, 60000)

  it('should scroll page frames through the extension relay', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({
      routes: {
        '/scroll-target': `<!doctype html>
          <html>
            <body style="margin:0">
              <div style="height:3200px; padding:20px">
                <div id="nested-scroller" role="region" aria-label="Nested scroll area" style="height:120px; width:240px; overflow:auto; border:1px solid #ccc">
                  <div style="height:700px; padding:8px">
                    <button id="nested-button" style="margin-top:20px">Nested action</button>
                  </div>
                </div>
                <div>Scroll target</div>
              </div>
              <script>
                let scrollCount = 0;
                window.addEventListener('scroll', () => {
                  scrollCount += 1;
                  document.body.setAttribute('data-scroll-count', String(scrollCount));
                  document.body.setAttribute('data-scroll-y', String(Math.round(window.scrollY)));
                });
                document.body.setAttribute('data-scroll-count', '0');
                document.body.setAttribute('data-scroll-y', '0');
                const nestedScroller = document.getElementById('nested-scroller');
                nestedScroller.addEventListener('scroll', () => {
                  nestedScroller.setAttribute('data-scroll-y', String(Math.round(nestedScroller.scrollTop)));
                });
                nestedScroller.setAttribute('data-scroll-y', '0');
              </script>
            </body>
          </html>`,
      },
    })
    const page = await browserContext.newPage()

    try {
      await page.goto(`${server.baseUrl}/scroll-target`, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
      expect(extensionsStatusRes.status).toBe(200)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions.find((candidate) => {
        return (candidate.browserTabs?.windows ?? []).some((window) => {
          return (window.tabs ?? []).some((tab) => tab.url === `${server.baseUrl}/scroll-target`)
        })
      })
      const browserTab = extension?.browserTabs?.windows
        ?.flatMap((window) => window.tabs ?? [])
        .find((tab) => tab.url === `${server.baseUrl}/scroll-target`)
      expect(extension).toBeDefined()
      expect(browserTab).toBeDefined()

      const elementInventoryRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: 0,
          maxElements: 20,
        }),
      })
      expect(elementInventoryRes.status).toBe(200)
      const elementInventoryJson = await elementInventoryRes.json() as {
        success: boolean
        frames: Array<{
          frameId: number
          elements: Array<{ refId: string; name: string }>
        }>
      }
      expect(elementInventoryJson.success).toBe(true)
      const nestedButton = elementInventoryJson.frames[0]?.elements.find((element) => element.name === 'Nested action')
      expect(nestedButton).toBeDefined()

      const nestedScrollRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: 0,
          refId: nestedButton!.refId,
          deltaY: 240,
        }),
      })
      expect(nestedScrollRes.status).toBe(200)
      await expect(nestedScrollRes.json()).resolves.toMatchObject({
        success: true,
        chromeTabId: browserTab!.chromeTabId,
        frameId: 0,
        refId: nestedButton!.refId,
        scrollY: 240,
      })
      await expect.poll(() => {
        return page.evaluate(() => ({
          windowScrollY: Math.round(window.scrollY),
          nestedScrollY: document.getElementById('nested-scroller')?.getAttribute('data-scroll-y'),
        }))
      }).toEqual({
        windowScrollY: 0,
        nestedScrollY: '240',
      })

      const traceRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-trace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: 0,
          bounds: { x: 20, y: 20, width: 120, height: 40 },
          durationMs: 5_000,
        }),
      })
      expect(traceRes.status).toBe(200)
      await expect(traceRes.json()).resolves.toMatchObject({
        success: true,
        chromeTabId: browserTab!.chromeTabId,
        frameId: 0,
        bounds: { x: 20, y: 20, width: 120, height: 40 },
      })
      const traceBeforeScroll = await page.evaluate(() => {
        const trace = document.getElementById('interpreter-browser-control-trace')
        const rect = trace?.getBoundingClientRect()
        return rect ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null
      })
      expect(traceBeforeScroll).toEqual({ x: 20, y: 20 })

      const scrollRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: 0,
          deltaY: 700,
        }),
      })
      expect(scrollRes.status).toBe(200)
      await expect(scrollRes.json()).resolves.toMatchObject({
        success: true,
        chromeTabId: browserTab!.chromeTabId,
        frameId: 0,
        scrollY: expect.any(Number),
        viewport: {
          width: expect.any(Number),
          height: expect.any(Number),
        },
      })
      await expect.poll(() => {
        return page.evaluate(() => ({
          scrollY: Math.round(window.scrollY),
          scrollCount: document.body.getAttribute('data-scroll-count'),
          dataScrollY: document.body.getAttribute('data-scroll-y'),
        }))
      }).toEqual({
        scrollY: 700,
        scrollCount: '1',
        dataScrollY: '700',
      })
      const traceAfterScroll = await page.evaluate(() => {
        const trace = document.getElementById('interpreter-browser-control-trace')
        const rect = trace?.getBoundingClientRect()
        return rect ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null
      })
      expect(traceAfterScroll).toEqual({ x: 20, y: -680 })
    } finally {
      await page.close()
      await server.close()
    }
  }, 60000)

  it('should click page element refs through the extension relay', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({
      routes: {
        '/click-target': `<!doctype html>
          <html>
            <body>
              <button id="count" aria-label="Increment count">Clicked 0</button>
              <script>
                let count = 0;
                document.getElementById('count').addEventListener('click', () => {
                  count += 1;
                  document.getElementById('count').textContent = 'Clicked ' + count;
                  document.body.setAttribute('data-click-count', String(count));
                });
              </script>
            </body>
          </html>`,
      },
    })
    const page = await browserContext.newPage()
    let foregroundPage: Page | null = null

    try {
      await page.goto(`${server.baseUrl}/click-target`, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
      expect(extensionsStatusRes.status).toBe(200)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string; active?: boolean }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions.find((candidate) => {
        return (candidate.browserTabs?.windows ?? []).some((window) => {
          return (window.tabs ?? []).some((tab) => tab.url === `${server.baseUrl}/click-target`)
        })
      })
      const browserTab = extension?.browserTabs?.windows
        ?.flatMap((window) => window.tabs ?? [])
        .find((tab) => tab.url === `${server.baseUrl}/click-target`)
      expect(extension).toBeDefined()
      expect(browserTab).toBeDefined()

      const elementInventoryRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          maxElements: 10,
        }),
      })
      expect(elementInventoryRes.status).toBe(200)
      const elementInventoryJson = await elementInventoryRes.json() as {
        success: boolean
        frames: Array<{
          frameId: number
          elements: Array<{
            refId: string
            name: string
            text: string
            bounds: { x: number; y: number; width: number; height: number }
          }>
        }>
      }
      expect(elementInventoryJson.success).toBe(true)
      const frame = elementInventoryJson.frames[0]
      const button = frame.elements.find((element) => {
        return element.name === 'Increment count' && element.text === 'Clicked 0'
      })
      expect(button).toBeDefined()

      foregroundPage = await browserContext.newPage()
      await foregroundPage.goto('https://example.com/?test=foreground-tab', { waitUntil: 'domcontentloaded' })
      await foregroundPage.bringToFront()
      await expect.poll(async () => {
        const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
        const statusJson = await statusRes.json() as typeof extensionsStatusJson
        const tabs = statusJson.extensions.flatMap((candidate) => {
          return (candidate.browserTabs?.windows ?? []).flatMap((window) => window.tabs ?? [])
        })
        return {
          targetActive: tabs.find((tab) => tab.chromeTabId === browserTab!.chromeTabId)?.active,
          foregroundActive: tabs.find((tab) => tab.url === 'https://example.com/?test=foreground-tab')?.active,
        }
      }).toEqual({
        targetActive: false,
        foregroundActive: true,
      })

      const clickRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: frame.frameId,
          refId: button!.refId,
          durationMs: 3_000,
        }),
      })
      expect(clickRes.status).toBe(200)
      await expect(clickRes.json()).resolves.toMatchObject({
        success: true,
        chromeTabId: browserTab!.chromeTabId,
        frameId: frame.frameId,
        refId: button!.refId,
        bounds: button!.bounds,
      })
      await expect.poll(() => {
        return page.locator('#count').textContent()
      }).toBe('Clicked 1')
      await expect.poll(() => {
        return page.evaluate(() => ({
          clickCount: document.body.getAttribute('data-click-count'),
        }))
      }).toEqual({
        clickCount: '1',
      })
      await page.waitForFunction(() => {
        return Boolean(document.getElementById('interpreter-browser-control-trace'))
      }, null, { timeout: 5000 })

      const staleClickRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension!.stableKey || extension!.extensionId,
          chromeTabId: browserTab!.chromeTabId,
          frameId: frame.frameId,
          refId: button!.refId,
        }),
      })
      expect(staleClickRes.status).toBe(400)
      await expect(staleClickRes.json()).resolves.toMatchObject({
        success: false,
        error: 'refId is stale or not visible',
      })
    } finally {
      await foregroundPage?.close()
      await page.close()
      await server.close()
    }
  }, 60000)

  it('should expose iframe frames when connecting to an existing page over CDP', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const childServer = await createSimpleServer({
      routes: {
        '/child.html': '<!doctype html><html><body>child</body></html>',
      },
    })
    const childUrl = `${childServer.baseUrl}/child.html`

    const parentServer = await createSimpleServer({
      routes: {
        '/': `<!doctype html><html><body><iframe src="${childUrl}"></iframe></body></html>`,
      },
    })

    const page = await browserContext.newPage()
    try {
      await withTimeout({
        promise: page.goto(parentServer.baseUrl, { waitUntil: 'domcontentloaded', timeout: 5000 }),
        timeoutMs: 6000,
        errorMessage: 'Timed out loading parent page for iframe test',
      })
      await withTimeout({
        promise: page.frameLocator('iframe').locator('body').waitFor({ timeout: 5000 }),
        timeoutMs: 6000,
        errorMessage: 'Timed out waiting for iframe to attach in parent page',
      })
      expect(page.frames().map((frame) => frame.url())).toContain(childUrl)
      await page.bringToFront()

      await withTimeout({
        promise: serviceWorker.evaluate(async () => {
          await globalThis.toggleExtensionForActiveTab()
        }),
        timeoutMs: 5000,
        errorMessage: 'Timed out toggling extension for iframe test',
      })
      await new Promise((r) => {
        setTimeout(r, 400)
      })

      const browser = await withTimeout({
        promise: chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT })),
        timeoutMs: 5000,
        errorMessage: 'Timed out connecting over CDP for iframe test',
      })
      const context = browser.contexts()[0]
      const cdpPage = context.pages().find((candidate) => {
        return candidate.url().startsWith(parentServer.baseUrl)
      })
      expect(cdpPage).toBeDefined()

      const frames = cdpPage!.frames()
      const childFrame = frames.find((frame) => {
        return frame.url() === childUrl
      })

      expect(frames.length).toBe(2)
      expect(childFrame).toBeDefined()

      await withTimeout({
        promise: browser.close(),
        timeoutMs: 5000,
        errorMessage: 'Timed out closing CDP browser for iframe test',
      })
    } finally {
      await withTimeout({
        promise: page.close(),
        timeoutMs: 5000,
        errorMessage: 'Timed out closing page for iframe test',
      })
      await Promise.all([parentServer.close(), childServer.close()])
    }
  }, 60000)

  it('should resolve locators for cross-origin iframe that starts with empty src', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const childServer = await createSimpleServer({
      routes: {
        '/login.html': '<!doctype html><html><body><button id="login-btn">Login</button></body></html>',
        '/canvas.html': '<!doctype html><html><body><button id="canvas-btn">Canvas</button></body></html>',
      },
    })
    const loginUrl = `${childServer.baseUrl}/login.html`
    const canvasUrl = `${childServer.baseUrl}/canvas.html`

    const parentServer = await createSimpleServer({
      routes: {
        // Reproduces Framer-like plugin iframes: attached with empty src first,
        // then navigated cross-origin after auto-attach is active.
        '/': `<!doctype html>
<html>
  <body>
    <iframe id="plugin-frame"></iframe>
    <script>
      window.startPluginFlow = () => {
        const frame = document.getElementById('plugin-frame');
        frame.src = '${loginUrl}';
        setTimeout(() => {
          frame.src = '${canvasUrl}';
        }, 150);
      };
    </script>
  </body>
</html>`,
      },
    })

    const page = await browserContext.newPage()
    try {
      await withTimeout({
        promise: page.goto(parentServer.baseUrl, { waitUntil: 'domcontentloaded', timeout: 5000 }),
        timeoutMs: 6000,
        errorMessage: 'Timed out loading parent page for empty-src iframe test',
      })
      await page.bringToFront()

      await withTimeout({
        promise: serviceWorker.evaluate(async () => {
          await globalThis.toggleExtensionForActiveTab()
        }),
        timeoutMs: 5000,
        errorMessage: 'Timed out toggling extension for empty-src iframe test',
      })

      const browser = await withTimeout({
        promise: chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT })),
        timeoutMs: 5000,
        errorMessage: 'Timed out connecting over CDP for empty-src iframe test',
      })

      try {
        const context = browser.contexts()[0]
        const cdpPage = context.pages().find((candidate) => {
          return candidate.url().startsWith(parentServer.baseUrl)
        })
        expect(cdpPage).toBeDefined()

        await withTimeout({
          promise: page.evaluate(() => {
            ;(window as Window & { startPluginFlow?: () => void }).startPluginFlow?.()
          }),
          timeoutMs: 3000,
          errorMessage: 'Timed out starting plugin iframe flow',
        })

        const pluginFrame = await withTimeout({
          promise: (async () => {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              const frame = cdpPage!.frames().find((candidate) => {
                return candidate.url() === loginUrl || candidate.url() === canvasUrl
              })
              if (frame) {
                return frame
              }
              await cdpPage!.waitForTimeout(100)
            }
            throw new Error('Plugin frame did not appear with expected URL')
          })(),
          timeoutMs: 5000,
          errorMessage: 'Timed out waiting for plugin frame URL in empty-src iframe test',
        })

        await withTimeout({
          promise: pluginFrame.locator('button').first().waitFor({ state: 'attached' }),
          timeoutMs: 5000,
          errorMessage: 'Timed out waiting for button locator in empty-src iframe test',
        })

        const buttonCount = await pluginFrame.locator('button').count()
        expect(buttonCount).toBe(1)
      } finally {
        await withTimeout({
          promise: browser.close(),
          timeoutMs: 5000,
          errorMessage: 'Timed out closing CDP browser for empty-src iframe test',
        })
      }
    } finally {
      await withTimeout({
        promise: page.close(),
        timeoutMs: 5000,
        errorMessage: 'Timed out closing page for empty-src iframe test',
      })
      await Promise.all([parentServer.close(), childServer.close()])
    }
  }, 60000)

  it('should have non-empty URLs when connecting to already-loaded pages', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const server = await createSimpleServer({
      routes: {
        '/already-loaded': '<!doctype html><html><body><h1>Already loaded</h1></body></html>',
      },
    })
    const page = await browserContext.newPage()

    try {
      const expectedUrl = `${server.baseUrl}/already-loaded`
      await page.goto(expectedUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })

      const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
      try {
        const pages = browser.contexts()[0].pages()
        console.log(
          'All page URLs:',
          pages.map((candidate) => candidate.url()),
        )

        expect(pages.length).toBeGreaterThan(0)
        for (const candidate of pages) {
          expect(candidate.url()).not.toBe('')
          expect(candidate.url()).not.toBe(':')
          expect(candidate.url()).not.toBeUndefined()
        }

        const loadedPage = pages.find((candidate) => candidate.url() === expectedUrl)
        expect(loadedPage).toBeDefined()
        expect(await loadedPage!.evaluate(() => window.location.href)).toBe(expectedUrl)
      } finally {
        await browser.close()
      }
    } finally {
      await page.close()
      await server.close()
    }
  }, 60000)

  it('should navigate to notion without hanging', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    const initialUrl = 'https://example.com/notion-repro'
    await page.goto(initialUrl)
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    await new Promise((r) => setTimeout(r, 100))

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url() === initialUrl)
    expect(cdpPage).toBeDefined()

    const response = await cdpPage!.goto('https://www.notion.so', { waitUntil: 'domcontentloaded', timeout: 20000 })

    const currentUrl = cdpPage!.url()
    const responseUrl = response?.url() ?? ''
    expect(responseUrl).toMatch(/notion\.(so|com)/)
    expect(currentUrl).toMatch(/notion\.(so|com)/)
    expect(await cdpPage!.evaluate(() => document.readyState)).not.toBe('loading')

    await browser.close()
    await page.close()
  }, 60000)

  it('should navigate to youtube without hanging', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('about:blank')
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    await new Promise((r) => setTimeout(r, 100))

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes('about:'))
    expect(cdpPage).toBeDefined()

    const response = await cdpPage!.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 })
    const currentUrl = cdpPage!.url()
    const responseUrl = response?.url() ?? ''

    expect(responseUrl).toContain('youtube')
    expect(currentUrl).toContain('youtube')
    await waitForStableDocumentReadyState({ page: cdpPage!, timeoutMs: 5000 })

    await browser.close()
    await page.close()
  }, 60000)

  it('should maintain correct page.url() with iframe-heavy pages', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.setContent(`
            <html>
                <head><title>Iframe Test Page</title></head>
                <body>
                    <h1>Iframe Heavy Page</h1>
                    <iframe src="about:blank" id="frame1"></iframe>
                    <iframe src="about:blank" id="frame2"></iframe>
                    <iframe src="about:blank" id="frame3"></iframe>
                </body>
            </html>
        `)
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    await new Promise((r) => setTimeout(r, 100))

    for (let i = 0; i < 3; i++) {
      const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
      const pages = browser.contexts()[0].pages()
      let iframePage
      for (const p of pages) {
        const html = await p.content()
        if (html.includes('Iframe Heavy Page')) {
          iframePage = p
          break
        }
      }

      expect(iframePage).toBeDefined()
      expect(iframePage?.url()).toContain('about:')

      await browser.close()
      await new Promise((r) => setTimeout(r, 100))
    }

    await page.close()
  }, 30000)

  it('should work with stagehand', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    await serviceWorker.evaluate(async () => {
      await globalThis.disconnectEverything()
    })
    await new Promise((r) => setTimeout(r, 100))

    const targetUrl = 'https://example.com/'

    const enableResult = await serviceWorker.evaluate(async (url) => {
      const tab = await chrome.tabs.create({ url, active: true })
      await new Promise((r) => setTimeout(r, 100))
      return await globalThis.toggleExtensionForActiveTab()
    }, targetUrl)

    console.log('Extension enabled:', enableResult)
    expect(enableResult.isConnected).toBe(true)

    await new Promise((r) => setTimeout(r, 100))

    const { Stagehand } = await import('@browserbasehq/stagehand')

    const stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: 1,
      disablePino: true,
      localBrowserLaunchOptions: {
        cdpUrl: getCdpUrl({ port: TEST_PORT }),
      },
    })

    console.log('Initializing Stagehand...')
    await stagehand.init()
    console.log('Stagehand initialized')

    const context = stagehand.context
    expect(context).toBeDefined()

    const pages = context.pages()
    console.log(
      'Stagehand pages:',
      pages.length,
      pages.map((p) => p.url()),
    )

    const stagehandPage = pages.find((p) => p.url().includes('example.com'))
    expect(stagehandPage).toBeDefined()

    const url = stagehandPage!.url()
    console.log('Stagehand page URL:', url)
    expect(url).toContain('example.com')

    await stagehand.close()
  }, 60000)

  it('should expose CDP discovery endpoints /json/version and /json/list', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const discoveryUrl = 'https://example.com/?test=cdp-discovery-endpoints'

    const page = await browserContext.newPage()
    await page.goto(discoveryUrl)
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await new Promise((r) => setTimeout(r, 200))

    // Test /json/version
    const versionRes = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`)
    expect(versionRes.status).toBe(200)
    const versionJson = (await versionRes.json()) as { webSocketDebuggerUrl: string }
    expect(versionJson).toMatchObject({
      Browser: expect.stringContaining('InterpreterChromeExtension/'),
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: expect.stringContaining('ws://'),
    })
    expect(versionJson.webSocketDebuggerUrl).toContain(`127.0.0.1:${TEST_PORT}/cdp/`)

    // Test /json/version/ (trailing slash)
    const versionSlashRes = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version/`)
    expect(versionSlashRes.status).toBe(200)
    const versionSlashJson = (await versionSlashRes.json()) as { webSocketDebuggerUrl: string }
    expect(versionSlashJson.webSocketDebuggerUrl).toContain(`127.0.0.1:${TEST_PORT}/cdp/`)
    expect(versionSlashJson.webSocketDebuggerUrl).not.toBe(versionJson.webSocketDebuggerUrl)

    // Test /json/list
    const listRes = await fetch(`http://127.0.0.1:${TEST_PORT}/json/list`)
    expect(listRes.status).toBe(200)
    const listJson = (await listRes.json()) as Array<{ url?: string }>
    expect(Array.isArray(listJson)).toBe(true)
    expect(listJson.length).toBeGreaterThan(0)

    const examplePage = listJson.find((t) => t.url?.includes(discoveryUrl))
    expect(examplePage).toBeDefined()
    expect(examplePage).toMatchObject({
      id: expect.any(String),
      type: 'page',
      url: discoveryUrl,
      webSocketDebuggerUrl: expect.stringContaining('ws://'),
    })

    // Test /json (alias for /json/list)
    const jsonRes = await fetch(`http://127.0.0.1:${TEST_PORT}/json`)
    expect(jsonRes.status).toBe(200)
    const jsonData = await jsonRes.json()
    expect(Array.isArray(jsonData)).toBe(true)

    // Test PUT method (Chrome 66+ prefers PUT)
    const putRes = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`, { method: 'PUT' })
    expect(putRes.status).toBe(200)

    const unsharedPage = await browserContext.newPage()
    await unsharedPage.goto('https://example.com/?test=unshared-tab-inventory')
    await page.bringToFront()

    const extensionsStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
    expect(extensionsStatusRes.status).toBe(200)
    const extensionsStatusJson = (await extensionsStatusRes.json()) as {
      extensions: Array<{
        extensionId: string
        stableKey?: string
        targets?: Array<{ title: string; url: string; type: string }>
        browserTabs?: {
          windows?: Array<{
            windowId: number
            focused: boolean
            tabs?: Array<{
              chromeTabId: number
              windowId: number
              active: boolean
              title: string
              url: string
              controlState: 'observable' | 'controllable'
              controlStateDetail?: string
              shared: boolean
              targetId?: string
            }>
          }>
        }
      }>
    }
    expect(extensionsStatusJson.extensions.length).toBeGreaterThan(0)
    expect(
      extensionsStatusJson.extensions.some((extension) => {
        return (extension.targets ?? []).some((target) => {
          return target.type === 'page' && target.url.includes('example.com')
        })
      }),
    ).toBe(true)

    const browserTabs = extensionsStatusJson.extensions.flatMap((extension) => {
      return (extension.browserTabs?.windows ?? []).flatMap((window) => window.tabs ?? [])
    })
    const sharedBrowserTab = browserTabs.find((tab) => tab.url === discoveryUrl)
    const unsharedBrowserTab = browserTabs.find((tab) => tab.url.includes('unshared-tab-inventory'))
    expect(sharedBrowserTab).toMatchObject({
      chromeTabId: expect.any(Number),
      windowId: expect.any(Number),
      shared: true,
      controlState: 'controllable',
      controlStateDetail: expect.any(String),
      targetId: expect.any(String),
    })
    expect(unsharedBrowserTab).toMatchObject({
      chromeTabId: expect.any(Number),
      windowId: expect.any(Number),
      shared: false,
      controlState: 'observable',
    })

    const extensionWithUnsharedTab = extensionsStatusJson.extensions.find((extension) => {
      return (extension.browserTabs?.windows ?? []).some((window) => {
        return (window.tabs ?? []).some((tab) => tab.chromeTabId === unsharedBrowserTab!.chromeTabId)
      })
    })
    expect(extensionWithUnsharedTab).toBeDefined()

    const activateRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/activate-tab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extensionId: extensionWithUnsharedTab!.stableKey || extensionWithUnsharedTab!.extensionId,
        chromeTabId: unsharedBrowserTab!.chromeTabId,
        windowId: unsharedBrowserTab!.windowId,
      }),
    })
    expect(activateRes.status).toBe(200)
    await expect(activateRes.json()).resolves.toMatchObject({ success: true })

    const activatedStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
    expect(activatedStatusRes.status).toBe(200)
    const activatedStatusJson = (await activatedStatusRes.json()) as typeof extensionsStatusJson
    const activatedTabs = activatedStatusJson.extensions.flatMap((extension) => {
      return (extension.browserTabs?.windows ?? []).flatMap((window) => window.tabs ?? [])
    })
    expect(activatedTabs.find((tab) => tab.chromeTabId === unsharedBrowserTab!.chromeTabId)).toMatchObject({
      active: true,
      shared: false,
      controlState: 'observable',
    })

    const claimTabRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/claim-tab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extensionId: extensionWithUnsharedTab!.stableKey || extensionWithUnsharedTab!.extensionId,
        chromeTabId: unsharedBrowserTab!.chromeTabId,
      }),
    })
    expect(claimTabRes.status).toBe(200)
    const claimTabJson = await claimTabRes.json() as {
      success: boolean
      chromeTabId: number
      targetId: string
      sessionId: string
    }
    expect(claimTabJson).toMatchObject({
      success: true,
      chromeTabId: unsharedBrowserTab!.chromeTabId,
      targetId: expect.any(String),
      sessionId: expect.any(String),
    })

    const claimedStatusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
    expect(claimedStatusRes.status).toBe(200)
    const claimedStatusJson = (await claimedStatusRes.json()) as typeof extensionsStatusJson
    const claimedTabs = claimedStatusJson.extensions.flatMap((extension) => {
      return (extension.browserTabs?.windows ?? []).flatMap((window) => window.tabs ?? [])
    })
    expect(claimedTabs.find((tab) => tab.chromeTabId === unsharedBrowserTab!.chromeTabId)).toMatchObject({
      shared: true,
      controlState: 'controllable',
      controlStateDetail: expect.any(String),
      targetId: claimTabJson.targetId,
    })

    const claimedBrowser = await chromium.connectOverCDP(
      getCdpUrl({
        port: TEST_PORT,
        extensionId: extensionWithUnsharedTab!.stableKey || extensionWithUnsharedTab!.extensionId,
      }),
    )
    const claimedPages = claimedBrowser.contexts().flatMap((context) => context.pages())
    expect(claimedPages.some((candidate) => candidate.url().includes('unshared-tab-inventory'))).toBe(true)
    await safeCloseCDPBrowser(claimedBrowser)

    const elementInventoryRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-elements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extensionId: extensionWithUnsharedTab!.stableKey || extensionWithUnsharedTab!.extensionId,
        chromeTabId: sharedBrowserTab!.chromeTabId,
        maxElements: 10,
      }),
    })
    expect(elementInventoryRes.status).toBe(200)
    const elementInventoryJson = await elementInventoryRes.json() as {
      success: boolean
      chromeTabId: number
      frames: Array<{
        frameId: number
        url: string
        documentRevision: string
        viewport: {
          width: number
          height: number
          scrollX: number
          scrollY: number
          devicePixelRatio: number
          screenBounds: { x: number; y: number; width: number; height: number } | null
        }
        elements: Array<{
          refId: string
          role: string
          bounds: { x: number; y: number; width: number; height: number }
        }>
      }>
    }
    expect(elementInventoryJson.success).toBe(true)
    expect(elementInventoryJson.chromeTabId).toBe(sharedBrowserTab!.chromeTabId)
    expect(elementInventoryJson.frames.length).toBeGreaterThan(0)
    expect(elementInventoryJson.frames[0]).toMatchObject({
      frameId: expect.any(Number),
      url: expect.stringContaining('example.com'),
      documentRevision: expect.any(String),
      viewport: {
        width: expect.any(Number),
        height: expect.any(Number),
        scrollX: expect.any(Number),
        scrollY: expect.any(Number),
        devicePixelRatio: expect.any(Number),
        screenBounds: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      },
    })
    expect(elementInventoryJson.frames[0].elements.length).toBeLessThanOrEqual(10)
    expect(elementInventoryJson.frames[0].elements.every((element) => {
      return element.refId.startsWith(`browser-element:${elementInventoryJson.frames[0].documentRevision}:`)
        && Number.isFinite(element.bounds.x)
        && element.bounds.width > 0
        && element.bounds.height > 0
    })).toBe(true)
    const traceTarget = elementInventoryJson.frames[0].elements[0]
    expect(traceTarget).toBeDefined()

    const pageTraceRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extensionId: extensionWithUnsharedTab!.stableKey || extensionWithUnsharedTab!.extensionId,
        chromeTabId: sharedBrowserTab!.chromeTabId,
        frameId: elementInventoryJson.frames[0].frameId,
        refId: traceTarget!.refId,
        durationMs: 3_000,
      }),
    })
    expect(pageTraceRes.status).toBe(200)
    await expect(pageTraceRes.json()).resolves.toMatchObject({
      success: true,
      chromeTabId: sharedBrowserTab!.chromeTabId,
      frameId: elementInventoryJson.frames[0].frameId,
      refId: traceTarget!.refId,
      bounds: traceTarget!.bounds,
    })
    await page.waitForFunction(() => {
      return Boolean(document.getElementById('interpreter-browser-control-trace'))
    }, null, { timeout: 5000 })
    const traceBox = await page.evaluate(() => {
      const trace = document.getElementById('interpreter-browser-control-trace')
      if (!trace) return null
      const rect = trace.getBoundingClientRect()
      return {
        ariaHidden: trace.getAttribute('aria-hidden'),
        pointerEvents: window.getComputedStyle(trace).pointerEvents,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    })
    expect(traceBox).toEqual({
      ariaHidden: 'true',
      pointerEvents: 'none',
      ...traceTarget!.bounds,
    })

    const staleTraceRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/page-trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extensionId: extensionWithUnsharedTab!.stableKey || extensionWithUnsharedTab!.extensionId,
        chromeTabId: sharedBrowserTab!.chromeTabId,
        frameId: elementInventoryJson.frames[0].frameId,
        refId: `${traceTarget!.refId}-stale`,
      }),
    })
    expect(staleTraceRes.status).toBe(400)
    await expect(staleTraceRes.json()).resolves.toMatchObject({
      success: false,
      error: 'refId is stale or not visible',
    })

    await unsharedPage.close()
    await page.close()
  }, 60000)

  it('should allow repeated connectOverCDP calls through the HTTP discovery endpoint', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/?test=discovery-reconnect')
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await new Promise((r) => setTimeout(r, 200))

    const relayUrl = `http://127.0.0.1:${TEST_PORT}`
    const firstBrowser = await chromium.connectOverCDP(relayUrl)
    const secondBrowser = await chromium.connectOverCDP(relayUrl)

    const firstPages = firstBrowser.contexts().flatMap((context) => context.pages())
    const secondPages = secondBrowser.contexts().flatMap((context) => context.pages())

    expect(firstPages.some((p) => p.url().includes('example.com/?test=discovery-reconnect'))).toBe(true)
    expect(secondPages.some((p) => p.url().includes('example.com/?test=discovery-reconnect'))).toBe(true)

    await safeCloseCDPBrowser(firstBrowser)
    await safeCloseCDPBrowser(secondBrowser)
    await page.close()
  }, 60000)

  it('should connect to an explicitly selected extensionId from extensions status', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/?test=explicit-extension-selection')
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await new Promise((r) => setTimeout(r, 200))

    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/extensions/status`)
    expect(statusRes.status).toBe(200)
    const statusJson = (await statusRes.json()) as {
      extensions: Array<{
        extensionId: string
        stableKey?: string
        targets?: Array<{ title: string; url: string; type: string }>
      }>
    }

    const selectedExtension = statusJson.extensions.find((extension) => {
      return (extension.targets ?? []).some((target) => {
        return target.type === 'page' && target.url.includes('explicit-extension-selection')
      })
    })
    expect(selectedExtension).toBeDefined()

    const browser = await chromium.connectOverCDP(
      getCdpUrl({
        port: TEST_PORT,
        extensionId: selectedExtension!.stableKey || selectedExtension!.extensionId,
      }),
    )
    const cdpPages = browser.contexts().flatMap((context) => context.pages())
    expect(cdpPages.some((p) => p.url().includes('explicit-extension-selection'))).toBe(true)

    await safeCloseCDPBrowser(browser)
    await page.close()
  }, 60000)

  // Regression test for https://github.com/remorses/playwriter/issues/40
  // When Playwright sends Target.detachFromTarget on the root CDP session (no top-level
  // sessionId), the extension must still route the command by looking at params.sessionId.
  // Previously the extension threw "No tab found for method Target.detachFromTarget"
  // because it only checked the top-level sessionId for routing, which is absent on root
  // session commands. This caused cascading disconnects and instability.
  it('should route Target.detachFromTarget without top-level sessionId (issue #40)', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const server = await createSimpleServer({
      routes: { '/': '<!doctype html><html><body>detach test</body></html>' },
    })

    const page = await browserContext.newPage()
    try {
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      await withTimeout({
        promise: serviceWorker.evaluate(async () => {
          await globalThis.toggleExtensionForActiveTab()
        }),
        timeoutMs: 5000,
        errorMessage: 'Timed out toggling extension for detach test',
      })
      await new Promise((r) => {
        setTimeout(r, 400)
      })

      // Connect a raw WebSocket to the relay — this lets us send CDP messages
      // exactly as they appear on the wire, without Playwright adding sessionId.
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cdp/test-detach-raw`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          resolve()
        })
        ws.on('error', reject)
      })

      let nextId = 1
      const sendCdp = <T = unknown>(msg: Record<string, unknown>): Promise<T> => {
        return new Promise((resolve, reject) => {
          const id = nextId++
          const timeout = setTimeout(() => {
            ws.off('message', handler)
            reject(new Error(`CDP response timeout for id ${id}`))
          }, 5000)

          const handler = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (parsed.id === id) {
              ws.off('message', handler)
              clearTimeout(timeout)
              resolve(parsed as T)
            }
          }
          ws.on('message', handler)
          ws.send(JSON.stringify({ id, ...msg }))
        })
      }

      // Collect async events from the relay
      const events: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (!msg.id && msg.method) {
          events.push(msg)
        }
      })

      // Trigger Target.setAutoAttach so the relay sends Target.attachedToTarget for
      // all connected tabs. This gives us the page's pw-tab-* sessionId.
      await sendCdp({
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      })

      // Wait for events to arrive
      await new Promise((r) => {
        setTimeout(r, 500)
      })

      // Filter for the specific page target by URL to avoid grabbing wrong sessions
      // (welcome tab, extension pages, etc.)
      type AttachParams = { sessionId?: string; targetInfo?: { type?: string; url?: string } }
      const attachEvent = events.find((e) => {
        if (e.method !== 'Target.attachedToTarget') {
          return false
        }
        const p = e.params as AttachParams
        return p.targetInfo?.type === 'page' && p.targetInfo?.url?.startsWith(server.baseUrl)
      })
      expect(attachEvent).toBeDefined()
      const pageSessionId = (attachEvent!.params as AttachParams).sessionId
      expect(pageSessionId).toBeTruthy()

      // Verify the session is usable before detach — send a command that requires routing.
      const evalBefore = await sendCdp<{ id: number; error?: { message: string }; result?: unknown }>({
        method: 'Runtime.evaluate',
        sessionId: pageSessionId,
        params: { expression: '1 + 1', returnByValue: true },
      })
      expect(evalBefore.error).toBeUndefined()
      expect((evalBefore.result as { result?: { value?: number } })?.result?.value).toBe(2)

      // NOW: send Target.detachFromTarget WITHOUT a top-level sessionId.
      // This is the exact wire format Playwright uses when sending on the root session
      // (e.g. from CRSession.detach() where _parentSession is the root browser session).
      // The extension must route this by looking at params.sessionId.
      const detachResult = await sendCdp<{ id: number; error?: { message: string }; result?: unknown }>({
        method: 'Target.detachFromTarget',
        // Intentionally NO sessionId field — this is the root session
        params: { sessionId: pageSessionId },
      })

      // Must not fail with extension routing error — the command must reach Chrome.
      // Chrome rejects pw-tab-* because it is a virtual session managed by the relay,
      // not a real Chrome CDP session. The exact Chrome error varies by browser build.
      // The key proof is that the extension routed the command to Chrome instead of
      // throwing "No tab found" at the routing layer.
      expect(detachResult.error?.message).not.toContain('No tab found')
      expect(detachResult.error?.message).toMatch(/No session with given id|Not allowed/)

      ws.close()
    } finally {
      await page.close()
      await server.close()
    }
  }, 30000)

  it('should not crash when page has chrome-extension:// iframe from another extension', async () => {
    // Reproduces https://github.com/remorses/playwriter/issues/18
    // Extensions like LastPass, SurfingKeys inject chrome-extension:// iframes into every page.
    // When playwriter attaches the debugger and Target.setAutoAttach is active, Chrome
    // auto-attaches to these restricted iframe targets. Without filtering, the relay tries
    // to send Runtime.runIfWaitingForDebugger to the restricted child session, which Chrome
    // blocks with "Cannot access a chrome-extension:// URL of a different extension",
    // causing the entire debugger to detach.

    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    // Discover the fixture extension's ID from its service worker
    const playwriterExtId = serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/)?.[1]
    expect(playwriterExtId).toBeTruthy()

    let fixtureExtId: string | undefined
    for (let i = 0; i < 50; i++) {
      const allSws = browserContext.serviceWorkers()
      const fixtureSw = allSws.find((sw) => {
        const id = sw.url().match(/chrome-extension:\/\/([^/]+)/)?.[1]
        return id && id !== playwriterExtId
      })
      if (fixtureSw) {
        fixtureExtId = fixtureSw.url().match(/chrome-extension:\/\/([^/]+)/)?.[1]
        break
      }
      await new Promise((r) => {
        setTimeout(r, 100)
      })
    }
    expect(fixtureExtId).toBeTruthy()
    console.log('Fixture extension ID:', fixtureExtId)

    // Create a page that embeds the fixture extension's page as an iframe,
    // reproducing what extensions like SurfingKeys/LastPass do.
    const server = await createSimpleServer({
      routes: {
        '/': `<!doctype html><html><body>
          <h1>Main page</h1>
          <iframe src="chrome-extension://${fixtureExtId}/page.html" id="ext-iframe"></iframe>
        </body></html>`,
      },
    })

    const page = await browserContext.newPage()
    try {
      await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront()

      // Enable playwriter on this page — this must NOT crash the debugger
      await withTimeout({
        promise: serviceWorker.evaluate(async () => {
          await globalThis.toggleExtensionForActiveTab()
        }),
        timeoutMs: 5000,
        errorMessage: 'Timed out toggling extension on page with chrome-extension:// iframe',
      })

      // Give time for any async errors (Target.attachedToTarget for the iframe) to surface
      await new Promise((r) => {
        setTimeout(r, 1500)
      })

      // Verify the extension is still connected by connecting over CDP and interacting
      const browser = await withTimeout({
        promise: chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT })),
        timeoutMs: 5000,
        errorMessage: 'Timed out connecting over CDP — extension likely crashed',
      })
      const context = browser.contexts()[0]
      const cdpPage = context.pages().find((p) => p.url().startsWith(server.baseUrl))
      expect(cdpPage).toBeDefined()

      // Verify we can execute JS on the page (proves the debugger session is alive)
      const title = await cdpPage!.evaluate(() => document.querySelector('h1')?.textContent)
      expect(title).toBe('Main page')

      // Verify the chrome-extension:// iframe did NOT get exposed as a frame
      // (it should be filtered out as a restricted target)
      const frames = cdpPage!.frames()
      const extFrame = frames.find((f) => f.url().startsWith('chrome-extension://'))
      expect(extFrame).toBeUndefined()

      await browser.close()
    } finally {
      // Toggle off to clean up
      await page.bringToFront()
      await serviceWorker
        .evaluate(async () => {
          await globalThis.toggleExtensionForActiveTab()
        })
        .catch(() => {})
      await page.close()
      await server.close()
    }
  }, 30000)
})
