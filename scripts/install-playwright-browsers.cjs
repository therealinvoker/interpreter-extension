#!/usr/bin/env node

const path = require('node:path')
const { createRequire } = require('node:module')

const compatPreload = path.resolve(__dirname, 'playwright-cjs-compat.cjs')
const existingNodeOptions = process.env.NODE_OPTIONS?.trim()
process.env.NODE_OPTIONS = [existingNodeOptions, `--require=${compatPreload}`].filter(Boolean).join(' ')

const playwriterPackage = require.resolve('../playwriter/package.json')
const requireFromPlaywriter = createRequire(playwriterPackage)
const corePackage = requireFromPlaywriter.resolve('@xmorse/playwright-core/package.json')
const coreRoot = path.dirname(corePackage)

require(compatPreload)

const { registry } = require(path.join(coreRoot, 'lib/server/registry'))

const names = ['chromium', 'chromium-headless-shell']
const executables = names.map((name) => {
  const executable = registry.findExecutable(name)
  if (!executable) {
    throw new Error(`Pinned Playwright runtime does not define ${name}`)
  }
  return executable
})

async function main() {
  if (process.argv.includes('--with-deps')) {
    await registry.installDeps(executables, false)
  }
  await registry.install(executables)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
