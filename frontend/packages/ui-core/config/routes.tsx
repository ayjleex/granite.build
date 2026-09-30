'use client'

import React from 'react'
import { type AppRoutes, DEFAULT_ROUTES } from './routeShapes'

// Re-exported so `config/routes` remains the single import path for consumers,
// while the pure builders stay importable from a module without 'use client'.
// See routeShapes.ts for why the split exists.
export { DEFAULT_ROUTES } from './routeShapes'
export type { AppRoutes } from './routeShapes'

const RoutesContext = React.createContext<AppRoutes>(DEFAULT_ROUTES)

/**
 * Override the link shape for everything below. Mount once, near the root.
 *
 * `value` does not need memoising by the caller: an object literal written inline
 * would be a new reference every render, so the provider memoises on the two
 * builders it actually contains. `AppRoutes` is a stateless bag of pure
 * functions, which is what makes that safe — there is no state to go stale, and
 * a caller passing a module-level constant pays nothing for the check.
 *
 * The previous version documented this as the caller's obligation instead. That
 * failed silently when ignored: every consumer re-rendered on every parent
 * render, which is a perf cliff rather than an error, so nothing surfaced it.
 */
export function RoutesProvider({
  value,
  children,
}: {
  value: AppRoutes
  children: React.ReactNode
}) {
  const memoised = React.useMemo<AppRoutes>(
    () => value,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value.buildHref, value.artifactHref],
  )
  return <RoutesContext.Provider value={memoised}>{children}</RoutesContext.Provider>
}

/**
 * Read the active route builders. Returns {@link DEFAULT_ROUTES} when no
 * provider is mounted, so this is safe to call from any shared component
 * without requiring consumers to change.
 *
 * No warning is emitted when the default is in effect, deliberately: the
 * standalone app mounts no provider by design, so warning on it would fire
 * constantly in the primary consumer and train people to ignore the message.
 */
export function useRoutes(): AppRoutes {
  return React.useContext(RoutesContext)
}
