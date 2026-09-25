import { Avatar as AvatarPrimitive } from '@base-ui/react/avatar'
import * as React from 'react'

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

const avatarSizes = {
  sm: 'neo-avatar-sm',
  default: 'neo-avatar-default',
  lg: 'neo-avatar-lg',
}

/**
 * Neobrutalism.dev Avatar component, adapted from the current Base UI registry
 * implementation to Papyrus' plain CSS stack. The component API intentionally mirrors
 * neobrutalism.dev so feature code can use AvatarImage/Fallback/Group without bespoke DOM.
 */
export function Avatar({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: 'default' | 'sm' | 'lg'
}) {
  return <AvatarPrimitive.Root
    data-slot="avatar"
    data-size={size}
    className={typeof className === 'function'
      ? (state) => classes('neo-avatar', avatarSizes[size], className(state))
      : classes('neo-avatar', avatarSizes[size], className)}
    {...props}
  />
}

export function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return <AvatarPrimitive.Image
    data-slot="avatar-image"
    className={typeof className === 'function' ? (state) => classes('neo-avatar-image', className(state)) : classes('neo-avatar-image', className)}
    {...props}
  />
}

export function AvatarFallback({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return <AvatarPrimitive.Fallback
    data-slot="avatar-fallback"
    className={typeof className === 'function' ? (state) => classes('neo-avatar-fallback', className(state)) : classes('neo-avatar-fallback', className)}
    {...props}
  />
}

export function AvatarBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="avatar-badge" className={classes('neo-avatar-badge', className)} {...props} />
}

export function AvatarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="avatar-group" className={classes('neo-avatar-group', className)} {...props} />
}

export function AvatarGroupCount({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="avatar-group-count" className={classes('neo-avatar-group-count', className)} {...props} />
}
