import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { installEnterKeyHint, installChipTriggerFix } from './keys'
import { registerPwa } from './pwa'
installEnterKeyHint()
installChipTriggerFix()
registerPwa()

// The server issues a fresh session cookie on each start (it gates every user action). When a POST comes back
// 403 with x-herdr-session, reload the page once to pick the new cookie up — at most every 10s.
const realFetch = window.fetch.bind(window)
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const r = await realFetch(...args)
  if (r.status === 403 && r.headers.get('x-herdr-session')) {
    let last = 0
    try { last = Number(sessionStorage.getItem('hd-reload') ?? 0) } catch { /* private mode */ }
    if (Date.now() - last > 10_000) {
      try { sessionStorage.setItem('hd-reload', String(Date.now())) } catch { /* private mode */ }
      location.reload()
    }
  }
  return r
}
import App from './App.tsx'

const qc = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
