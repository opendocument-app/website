// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://opendocument.app',
  // Firebase Hosting serves `/foo` for `/foo.html`, so directory-style URLs
  // would 301 through a redirect for no gain on a one-page site.
  build: { format: 'file' },
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
