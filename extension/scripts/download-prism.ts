// Stages vendored Prism.js assets into <outDir>/src/ for the welcome page.
// Chrome extension CSP blocks external scripts, and builds must not depend on
// a third-party CDN being available.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = process.env.PLAYWRITER_EXTENSION_DIST || 'dist'
const DEST = path.join(outDir, 'src')
const SOURCE = fileURLToPath(new URL('../vendor/prism-1.29.0/', import.meta.url))

const files = ['prism.min.js', 'prism-bash.min.js']

function main() {
  fs.mkdirSync(DEST, { recursive: true })
  for (const file of files) {
    fs.copyFileSync(path.join(SOURCE, file), path.join(DEST, file))
  }
  console.log(`Staged ${files.length} vendored Prism.js files to ${DEST}`)
}

main()
