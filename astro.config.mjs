// @ts-check
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

/*
  The renderer is imported by url at runtime, out of the versioned directory
  `scripts/sync-odr.mjs` copies it into, so the bundle needs the version as a
  value. Read from the same manifest that script reads, which is what keeps the
  two in step; npm remains the source of truth for both.
*/
const manifest = createRequire(import.meta.url).resolve('@opendocument/odr-core/package.json');
const { version: odrVersion } = JSON.parse(readFileSync(manifest, 'utf8'));

export default defineConfig({
  site: 'https://opendocument.app',
  // Firebase Hosting serves `/foo` for `/foo.html`, so directory-style URLs
  // would 301 through a redirect for no gain on a one-page site.
  build: { format: 'file' },
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    define: { __ODR_VERSION__: JSON.stringify(odrVersion) },
  },
});
