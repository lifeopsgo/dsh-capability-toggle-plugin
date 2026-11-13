export interface PointerPoint {
  readonly x: number
  readonly y: number
}

export const SELECTION_DRAG_THRESHOLD_PX = 4

const POPUP_SCOPE = '.dshct-panel,.dshct-confirm'

export function isSelectionDrag(start: PointerPoint, end: PointerPoint): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) > SELECTION_DRAG_THRESHOLD_PX
}

function popupAncestor(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== 'object') return null
  const closest = (target as { closest?: unknown }).closest
  if (typeof closest !== 'function') return null
  return (target as Element).closest(POPUP_SCOPE)
}

export function installSelectionClickGuard(doc: Document): () => void {
  let start: PointerPoint | null = null
  let dragged = false
  const onDown = (event: MouseEvent): void => {
    start = { x: event.clientX, y: event.clientY }
    dragged = false
  }
  const onMove = (event: MouseEvent): void => {
    if (start === null || dragged) return
    dragged = isSelectionDrag(start, { x: event.clientX, y: event.clientY })
  }
  const onClick = (event: MouseEvent): void => {
    const travelled = dragged
    start = null
    dragged = false
    if (!travelled || event.detail === 0) return
    if (popupAncestor(event.target) === null) return
    event.stopPropagation()
  }
  doc.addEventListener('mousedown', onDown, true)
  doc.addEventListener('mousemove', onMove, true)
  doc.addEventListener('click', onClick, true)
  return () => {
    doc.removeEventListener('mousedown', onDown, true)
    doc.removeEventListener('mousemove', onMove, true)
    doc.removeEventListener('click', onClick, true)
  }
}
