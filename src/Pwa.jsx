import { useEffect, useState } from 'react'

/* Makes CareLoop installable: Chrome shows "Install app", iPhone uses Share > Add to Home Screen.
   The page parts below are added from here so index.html does not have to change. */
const add = (tag, attrs) => {
  const el = document.createElement(tag)
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v))
  document.head.appendChild(el)
}
if (typeof document !== 'undefined' && !document.querySelector('link[rel="manifest"]')) {
  add('link', { rel: 'manifest', href: '/manifest.webmanifest' })
  add('link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' })
  add('meta', { name: 'theme-color', content: '#F7F4D5', media: '(prefers-color-scheme: light)' })
  add('meta', { name: 'theme-color', content: '#05070F', media: '(prefers-color-scheme: dark)' })
  add('meta', { name: 'mobile-web-app-capable', content: 'yes' })
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' })
  add('meta', { name: 'apple-mobile-web-app-title', content: 'CareLoop' })
}
if (typeof window !== 'undefined' && 'serviceWorker' in navigator && window.location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}

/* "Install app" button: only appears when the browser says the app can be installed */
export function InstallButton() {
  const [offer, setOffer] = useState(null)
  useEffect(() => {
    const onOffer = e => { e.preventDefault(); setOffer(e) }
    const onDone = () => setOffer(null)
    window.addEventListener('beforeinstallprompt', onOffer)
    window.addEventListener('appinstalled', onDone)
    return () => { window.removeEventListener('beforeinstallprompt', onOffer); window.removeEventListener('appinstalled', onDone) }
  }, [])
  if (!offer) return null
  const install = async () => {
    offer.prompt()
    try { await offer.userChoice } catch { /* closed without choosing */ }
    setOffer(null)
  }
  return <button className="btn quiet" onClick={install}>Install app</button>
}
