import { defineConfig } from 'tsup'

// Two builds run in parallel, so `dist` is cleaned by the npm `prebuild` script instead of tsup.
const shared = {
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node22' as const,
  sourcemap: true,
  dts: false,
  splitting: false,
  minify: false
}

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts'],
    banner: {
      js: '#!/usr/bin/env node'
    }
  },
  {
    // pi extension loaded into the pi subprocess (see src/pi-rpc/fs-bridge.ts).
    // pi aliases @earendil-works/pi-coding-agent to its own installation at load time.
    ...shared,
    entry: { 'acp-fs-extension': 'src/pi-extension/acp-fs.ts' },
    external: ['@earendil-works/pi-coding-agent']
  }
])
