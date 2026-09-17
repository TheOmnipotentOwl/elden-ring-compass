import { createRouter } from '@tanstack/react-router';
import { NotFound } from './components/shell/not-found';
import { RoutePending } from './components/shell/route-pending';
import { routeTree } from './routeTree.gen';

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
    // During SSR / prerendering the Nitro server handles routes at '/' (root),
    // so we use basepath '/' server-side and let the client pick up the real
    // GitHub-Pages prefix (/elden-ring-compass/) from Vite's BASE_URL.
    // import.meta.env.SSR is statically replaced by Vite: true in the SSR
    // bundle, false in the client bundle — so each bundle gets the right value.
    basepath: import.meta.env.SSR ? '/' : import.meta.env.BASE_URL,
    defaultNotFoundComponent: NotFound,
    // Shown in the content area while a route resolves (mainly lazy chunk loads,
    // since data comes from in-memory atoms not async loaders).
    defaultPendingComponent: RoutePending,
    // Prefetch a route's chunk/loader on link hover (and focus) so navigation
    // feels instant; the Link transition + pending UI become a graceful fallback.
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }

  // Per-route opt-in flags read by the app shell (`_app.tsx`).
  interface StaticDataRouteOption {
    // The route owns the full viewport height: the shell bounds the content
    // region (`min-h-0`) so a `flex-1` child (e.g. a virtualized DataTable) fills
    // it exactly and scrolls internally, and drops the trailing footer. Without
    // this, routes flow at their natural height and the region scrolls.
    fill?: boolean;
    // `fill`, and additionally render edge-to-edge: the shell drops its page
    // padding so the route bleeds to the viewport bounds. Implies `fill`.
    fullBleed?: boolean;
  }
}
