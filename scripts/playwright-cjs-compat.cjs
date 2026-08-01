const { createRequire } = require('node:module')

const playwriterPackage = require.resolve('../playwriter/package.json')
const requireFromPlaywriter = createRequire(playwriterPackage)
const corePackage = requireFromPlaywriter.resolve('@xmorse/playwright-core/package.json')
const requireFromCore = createRequire(corePackage)

// The pinned fork's vendored adapters still expect the CommonJS shapes from
// signal-exit v3 and get-stream v8. Its declared v4/v9 dependencies expose
// the same functions as named/default exports. Normalize those two modules in
// the installer and its extraction child process without modifying the fork.
const signalExitPath = requireFromCore.resolve('signal-exit')
const signalExit = requireFromCore('signal-exit')
if (typeof signalExit !== 'function' && typeof signalExit.onExit === 'function') {
  require.cache[signalExitPath].exports = signalExit.onExit
}

const getStreamPath = requireFromCore.resolve('get-stream')
const getStream = requireFromCore('get-stream')
if (typeof getStream !== 'function' && typeof getStream.default === 'function') {
  require.cache[getStreamPath].exports = getStream.default
}
