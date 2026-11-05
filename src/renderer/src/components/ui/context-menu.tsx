import type { ComponentProps, ReactNode } from 'react'
import { ContextMenu as Menu } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export const ContextMenu = Menu.Root
export const ContextMenuTrigger = Menu.Trigger
export const ContextMenuSub = Menu.Sub

const panel =
  'z-50 min-w-48 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95'

const item =
  'relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-secondary [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content className={cn(panel, className)} {...props} />
    </Menu.Portal>
  )
}

export function ContextMenuItem({
  className,
  shortcut,
  children,
  ...props
}: ComponentProps<typeof Menu.Item> & { shortcut?: string }) {
  return (
    <Menu.Item className={cn(item, className)} {...props}>
      {children}
      {shortcut && (
        <kbd className="ml-auto font-mono text-xs text-muted-foreground">{shortcut}</kbd>
      )}
    </Menu.Item>
  )
}

export function ContextMenuSubTrigger({
  children,
  className,
  ...props
}: ComponentProps<typeof Menu.SubTrigger> & { children: ReactNode }) {
  return (
    <Menu.SubTrigger className={cn(item, 'data-[state=open]:bg-secondary', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </Menu.SubTrigger>
  )
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent className={cn(panel, className)} {...props} />
    </Menu.Portal>
  )
}

export function ContextMenuSeparator() {
  return <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
}
