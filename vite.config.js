import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run preview` sends the same security headers as production (vercel.json),
// so a Content-Security-Policy problem shows up before deploying.
const securityHeaders = Object.fromEntries(
  JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'))
    .headers.flatMap(rule => rule.headers.map(({ key, value }) => [key, value])),
)

export default defineConfig({
  plugins: [react()],
  preview: { headers: securityHeaders },
})
