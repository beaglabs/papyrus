import { existsSync, mkdirSync, symlinkSync } from 'node:fs'

const dataDir = process.env.PAPYRUS_DATA_DIR ?? '/var/lib/papyrus'

// First boot: point the sandbox's document toolchain at the system Python. The
// libs (pypdf/reportlab/pillow) are installed into the system site-packages at
// image build time, so a fresh volume gets document capability without network.
const pyBin = `${dataDir}/python/bin/python3`
if (!existsSync(pyBin)) {
  mkdirSync(`${dataDir}/python/bin`, { recursive: true })
  symlinkSync('/usr/bin/python3', pyBin)
}

// Run the daemon in-process; it registers its own SIGINT/SIGTERM handlers.
await import('/app/apps/server/dist/index.js')
