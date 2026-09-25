import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import * as React from 'react'

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

export function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

export function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

export function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

export function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

export function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return <DialogPrimitive.Backdrop
    data-slot="dialog-overlay"
    className={typeof className === 'function' ? (state) => classes('neo-dialog-overlay', className(state)) : classes('neo-dialog-overlay', className)}
    {...props}
  />
}

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & { showCloseButton?: boolean }) {
  return <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Popup
      data-slot="dialog-content"
      className={typeof className === 'function' ? (state) => classes('neo-dialog-content', className(state)) : classes('neo-dialog-content', className)}
      {...props}
    >
      {children}
      {showCloseButton && <DialogPrimitive.Close data-slot="dialog-close" className="neo-dialog-close" aria-label="Close">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>}
    </DialogPrimitive.Popup>
  </DialogPortal>
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={classes('neo-dialog-header', className)} {...props} />
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={classes('neo-dialog-footer', className)} {...props} />
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title
    data-slot="dialog-title"
    className={typeof className === 'function' ? (state) => classes('neo-dialog-title', className(state)) : classes('neo-dialog-title', className)}
    {...props}
  />
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description
    data-slot="dialog-description"
    className={typeof className === 'function' ? (state) => classes('neo-dialog-description', className(state)) : classes('neo-dialog-description', className)}
    {...props}
  />
}
