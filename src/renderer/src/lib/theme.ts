import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThemePreference } from '@shared/ipc'

function applyDark(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
}

export function useSyncDarkClass() {
  useEffect(() => {
    void window.prism.invoke('theme:isDark').then(applyDark)
    return window.prism.on('theme:changed', ({ dark }) => applyDark(dark))
  }, [])
}

export function useThemePreference() {
  return useQuery({
    queryKey: ['settings', 'theme'],
    queryFn: () => window.prism.invoke('settings:getTheme'),
  })
}

export function useSetThemePreference() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (theme: ThemePreference) => window.prism.invoke('settings:setTheme', theme),
    onSuccess: (theme) => client.setQueryData(['settings', 'theme'], theme),
  })
}
