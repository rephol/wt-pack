// A composer draft that survives a page reload (update, lost session): kept per key in sessionStorage.
import { useState, type Dispatch, type SetStateAction } from 'react'

const read = (k: string) => { try { return sessionStorage.getItem(`draft:${k}`) } catch { return null } }

export function useDraft(key: string, init: () => string): [string, Dispatch<SetStateAction<string>>] {
  const [v, set] = useState(() => init() || read(key) || '') // a pending prefill (spawn) wins over a saved draft
  const setDraft: Dispatch<SetStateAction<string>> = (next) => set((prev) => {
    const val = typeof next === 'function' ? next(prev) : next
    try { if (val) sessionStorage.setItem(`draft:${key}`, val); else sessionStorage.removeItem(`draft:${key}`) } catch { /* private mode */ }
    return val
  })
  return [v, setDraft]
}
