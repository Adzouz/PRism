import type { ComponentProps } from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex gap-1 border-b', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-2 py-2.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-primary data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn(
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        className,
      )}
      {...props}
    />
  )
}
