import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from '@tanstack/react-router'
import { AppSidebar } from '@/components/app-sidebar'
import { PrDrawer } from '@/features/board/drawer'
import { OnboardingPage } from '@/features/onboarding/onboarding'
import { useBoardEvents, useConfigStatus } from '@/lib/api'
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
  useBoardEvents()
  return <Outlet />
}

function AppLayout() {
  const { data: status } = useConfigStatus()
  if (status && !status.onboarded) return <Navigate to="/onboarding" />
  return (
    <div className="flex h-full p-3">
      <div className="drag fixed inset-x-0 top-0 z-50 h-3" />
      <AppSidebar />
      <main className="min-w-0 flex-1 overflow-y-auto pt-3 pr-7 pl-10">
        <Outlet />
      </main>
      <PrDrawer />
    </div>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppLayout })

const appRoutes = [
  createRoute({ getParentRoute: () => appRoute, path: '/', component: DashboardPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/reviews', component: ReviewsPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/my-prs', component: MyPrsPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/archive', component: ArchivePage }),
  createRoute({ getParentRoute: () => appRoute, path: '/runs', component: RunsPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsPage }),
]

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingPage,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([appRoute.addChildren(appRoutes), onboardingRoute]),
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
