import type { ReactNode } from 'react'
import { Tooltip as Tip } from 'radix-ui'

export const TooltipProvider = Tip.Provider

export function Tooltip({
  content,
  side = 'top',
  children,
}: {
  content: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
}) {
  return (
    <Tip.Root>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal>
        <Tip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {content}
        </Tip.Content>
      </Tip.Portal>
    </Tip.Root>
  )
}
