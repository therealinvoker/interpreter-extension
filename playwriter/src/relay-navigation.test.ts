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
        browserTabs: { windows: Array<{ tabs: Array<{ url: string; shared: boolean }> }> }
      }
      const inventoryTabs = statusJson.browserTabs.windows.flatMap((window) => window.tabs)
      expect(statusJson.activeTargets).toBe(0)
      expect(statusJson.targets).toEqual([])
      expect(inventoryTabs.some((tab) => tab.url.startsWith(server.baseUrl) && tab.shared === true)).toBe(true)

      const extensionsStatusRes = await fetch(`http://127.0.0.1:${NO_POLICY_TEST_PORT}/extensions/status`)
      const extensionsStatusJson = await extensionsStatusRes.json() as {
        extensions: Array<{
          extensionId: string
          stableKey?: string
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string }> }> }
        }>
      }
      const extension = extensionsStatusJson.extensions.find((candidate) => {
        return (candidate.browserTabs?.windows ?? []).some((window) => {
          return (window.tabs ?? []).some((tab) => tab.url.startsWith(server.baseUrl))
        })
      })
      const blockedTab = extension?.browserTabs?.windows
        ?.flatMap((window) => window.tabs ?? [])
        .find((tab) => tab.url.startsWith(server.baseUrl))
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
    } finally {
      await cleanupTestContext(noPolicyCtx)
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
          browserTabs?: { windows?: Array<{ tabs?: Array<{ chromeTabId: number; url: string }> }> }
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
    const _browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(_browserContext)

    const page = await _browserContext.newPage()
    await page.goto('https://discord.com/login', { waitUntil: 'load' })
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const context = browser.contexts()[0]

    const pages = context.pages()
    console.log(
      'All page URLs:',
      pages.map((p) => p.url()),
    )

    expect(pages.length).toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.url()).not.toBe('')
      expect(p.url()).not.toBe(':')
      expect(p.url()).not.toBeUndefined()
    }

    const discordPage = pages.find((p) => p.url().includes('discord.com'))
    expect(discordPage).toBeDefined()

    const result = await discordPage!.evaluate(() => window.location.href)
    expect(result).toContain('discord.com')

    await browser.close()
    await page.close()
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
      targetId: expect.any(String),
    })
    expect(unsharedBrowserTab).toMatchObject({
      chromeTabId: expect.any(Number),
      windowId: expect.any(Number),
      shared: false,
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
    })

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
