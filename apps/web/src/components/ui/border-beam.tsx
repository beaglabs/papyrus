import type { HTMLAttributes, ReactNode } from 'react'

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

/** Lightweight React wrapper for the 21st.dev-style traveling border beam effect. */
export function BorderBeam({ children, className, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return <span className={classes('border-beam', className)} {...props}>
    <span className="border-beam-track" aria-hidden="true" />
    <span className="border-beam-content">{children}</span>
  </span>
}
