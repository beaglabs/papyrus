import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

type SidebarState = 'expanded' | 'collapsed'

interface SidebarContextValue {
  state: SidebarState
  open: boolean
  setOpen: (open: boolean) => void
  isMobile: boolean
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  toggleSidebar: () => void
}

const SidebarContext = createContext<SidebarContextValue | undefined>(undefined)

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

export function SidebarProvider({
  defaultOpen = true,
  children,
  className,
  style,
}: {
  defaultOpen?: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [openMobile, setOpenMobile] = useState(false)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const changed = () => setIsMobile(media.matches)
    changed()
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])

  const toggleSidebar = useCallback(() => {
    if (isMobile) setOpenMobile((value) => !value)
    else setOpen((value) => !value)
  }, [isMobile])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'b' || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [toggleSidebar])

  const value = useMemo<SidebarContextValue>(() => ({
    state: open ? 'expanded' : 'collapsed',
    open,
    setOpen,
    isMobile,
    openMobile,
    setOpenMobile,
    toggleSidebar,
  }), [open, isMobile, openMobile, toggleSidebar])

  return <SidebarContext.Provider value={value}>
    <div
      data-slot="sidebar-wrapper"
      data-state={value.state}
      className={classes('nb-sidebar-wrapper', className)}
      style={{
        '--sidebar-width': '285px',
        '--sidebar-width-icon': '68px',
        ...style,
      } as CSSProperties}
    >
      {children}
    </div>
  </SidebarContext.Provider>
}

export function useSidebar() {
  const context = useContext(SidebarContext)
  if (!context) throw new Error('useSidebar must be used inside SidebarProvider')
  return context
}

export function Sidebar({
  children,
  className,
  collapsible = 'icon',
}: {
  children: ReactNode
  className?: string
  collapsible?: 'offcanvas' | 'icon' | 'none'
}) {
  const { state, isMobile, openMobile, setOpenMobile } = useSidebar()
  const visible = !isMobile || openMobile
  return <>
    {isMobile && visible && <button className="nb-sidebar-backdrop" aria-label="Close sidebar" onClick={() => setOpenMobile(false)} />}
    <aside
      data-slot="sidebar"
      data-state={state}
      data-mobile={isMobile ? 'true' : 'false'}
      data-open={visible ? 'true' : 'false'}
      data-collapsible={collapsible}
      className={classes('nb-sidebar', className)}
    >
      {children}
    </aside>
  </>
}

export function SidebarInset({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <main data-slot="sidebar-inset" className={classes('nb-sidebar-inset', className)} {...props} />
}

export function SidebarHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-header" className={classes('nb-sidebar-header', className)} {...props} />
}

export function SidebarContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-content" className={classes('nb-sidebar-content', className)} {...props} />
}

export function SidebarFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-footer" className={classes('nb-sidebar-footer', className)} {...props} />
}

export function SidebarGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section data-slot="sidebar-group" className={classes('nb-sidebar-group', className)} {...props} />
}

export function SidebarGroupLabel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-group-label" className={classes('nb-sidebar-group-label', className)} {...props} />
}

export function SidebarGroupContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="sidebar-group-content" className={classes('nb-sidebar-group-content', className)} {...props} />
}

export function SidebarMenu({ className, ...props }: HTMLAttributes<HTMLUListElement>) {
  return <ul data-slot="sidebar-menu" className={classes('nb-sidebar-menu', className)} {...props} />
}

export function SidebarMenuItem({ className, ...props }: HTMLAttributes<HTMLLIElement>) {
  return <li data-slot="sidebar-menu-item" className={classes('nb-sidebar-menu-item', className)} {...props} />
}

export function SidebarMenuButton({
  active = false,
  tooltip,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; tooltip?: string }) {
  return <button
    type="button"
    data-slot="sidebar-menu-button"
    data-active={active ? 'true' : 'false'}
    title={tooltip}
    className={classes('nb-sidebar-menu-button', className)}
    {...props}
  >{children}</button>
}

export function SidebarTrigger({ className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { toggleSidebar, state } = useSidebar()
  return <button
    {...props}
    type="button"
    data-slot="sidebar-trigger"
    className={classes('nb-sidebar-trigger', className)}
    aria-label={props['aria-label'] ?? (state === 'expanded' ? 'Collapse sidebar' : 'Expand sidebar')}
    onClick={(event) => {
      onClick?.(event)
      if (!event.defaultPrevented) toggleSidebar()
    }}
  ><span aria-hidden="true">☰</span></button>
}

export function SidebarRail({ className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { toggleSidebar } = useSidebar()
  return <button
    {...props}
    type="button"
    data-slot="sidebar-rail"
    tabIndex={-1}
    aria-label={props['aria-label'] ?? 'Toggle sidebar'}
    className={classes('nb-sidebar-rail', className)}
    onClick={(event) => {
      onClick?.(event)
      if (!event.defaultPrevented) toggleSidebar()
    }}
  />
}
