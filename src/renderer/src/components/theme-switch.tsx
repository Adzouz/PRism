import { Monitor, Moon, Sun } from 'lucide-react'
import { themePreference, type ThemePreference } from '@shared/ipc'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useSetThemePreference, useThemePreference } from '@/lib/theme'

const options: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export function ThemeSwitch({ showLabels = false }: { showLabels?: boolean }) {
  const { data: theme = 'system' } = useThemePreference()
  const setTheme = useSetThemePreference()

  return (
    <ToggleGroup
      type="single"
      value={theme}
      aria-label="Theme"
      onValueChange={(value) => {
        const parsed = themePreference.safeParse(value)
        if (parsed.success) setTheme.mutate(parsed.data)
      }}
    >
      {options.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem key={value} value={value} aria-label={label} title={label}>
          <Icon />
          {showLabels && label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
