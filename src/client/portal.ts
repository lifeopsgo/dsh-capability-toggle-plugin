import { useEffect, useState } from 'react'

export function usePortalHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const node = document.createElement('div')
    node.className = 'dshct-portal'
    document.body.appendChild(node)
    setHost(node)
    return () => {
      node.remove()
      setHost(null)
    }
  }, [])

  return host
}
