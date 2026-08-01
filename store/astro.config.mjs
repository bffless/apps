import { defineConfig } from 'astro/config'
import tailwind from '@astrojs/tailwind'

export default defineConfig({
  site: 'https://apps.bffless.dev',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [tailwind()],
})
