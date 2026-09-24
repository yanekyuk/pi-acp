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
    // Extensions loaded into the pi subprocess; pi aliases its own coding-agent installation.
    ...shared,
    entry: {
      'acp-fs-extension': 'src/pi-extension/acp-fs.ts',
      'anthropic-oauth-extension': 'src/pi-extension/anthropic-oauth.ts'
    },
    external: ['@earendil-works/pi-coding-agent']
  }
])
