import type { ComponentProps, ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root

export function DialogContent({
  title,
  description,
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="no-drag fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        className={cn(
          'no-drag fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(640px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl border bg-surface p-6 shadow-xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        <div className="space-y-1 pr-8">
          <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="text-sm text-muted-foreground">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        <DialogPrimitive.Close className="absolute top-5 right-5 rounded-md p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
