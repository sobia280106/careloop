import { useEffect, useState } from 'react'

/* Colour theme: Auto (follow the device), Light, or Dark. The choice is remembered on this device. */
const KEY = 'careloop-theme'
const ORDER = ['auto', 'light', 'dark']
const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' }
const ICON = { auto: '◐', light: '☀', dark: '☾' }

const read = () => {
  try { const v = localStorage.getItem(KEY); return ORDER.includes(v) ? v : 'auto' } catch { return 'auto' }
}
export const applyTheme = mode => {
  const root = document.documentElement
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode)
  else root.removeAttribute('data-theme')
}
applyTheme(read()) // runs as soon as the app loads, before the first screen is drawn

// Inter font (the CSS falls back to the system font while it loads or if it is blocked)
if (typeof document !== 'undefined' && !document.getElementById('careloop-inter')) {
  const link = document.createElement('link')
  link.id = 'careloop-inter'; link.rel = 'stylesheet'
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
  document.head.appendChild(link)
}

export function ThemeToggle() {
  const [mode, setMode] = useState(read)
  useEffect(() => { applyTheme(mode) }, [mode])
  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]
  const change = () => {
    try { localStorage.setItem(KEY, next) } catch { /* private mode: still works for this visit */ }
    setMode(next)
  }
  const text = `Colour theme: ${LABEL[mode]}. Switch to ${LABEL[next]}.`
  return (
    <button className="btn quiet theme-btn" onClick={change} aria-label={text} title={text}>
      <span aria-hidden="true">{ICON[mode]}</span> {LABEL[mode]}
    </button>
  )
}
