import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { AppSidebar } from '@/components/app-sidebar'
import { useSyncDarkClass } from '@/lib/theme'
import {
  ArchivePage,
  DashboardPage,
  MyPrsPage,
  ReviewsPage,
  RunsPage,
  SettingsPage,
} from '@/routes/pages'

function RootLayout() {
  useSyncDarkClass()
  return (
    <div className="flex h-full">
      <AppSidebar />
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/reviews', component: ReviewsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/my-prs', component: MyPrsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/archive', component: ArchivePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/runs', component: RunsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
]

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
