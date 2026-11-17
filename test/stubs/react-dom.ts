/**
 * Stand-in for `react-dom` in the Node test harnesses. The real package is a
 * browser external the host loader provides, so it is not installed here; this
 * stub keeps the portal recognisable to the element walkers, which descend
 * through `children`.
 */
export function createPortal(children: unknown, container?: unknown): unknown {
  return { $$typeof: Symbol.for('react.portal'), children, container }
}
