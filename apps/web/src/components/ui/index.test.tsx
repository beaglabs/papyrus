import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Badge, Button, Card, Checkbox, Combobox, Input, NativeSelect, Skeleton, TabsList, TabsTrigger, Textarea } from './index.js'
import { Sidebar, SidebarContent, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from './sidebar.js'

describe('neobrutalism UI primitives',()=>{
  it('exposes stable data slots for application styling',()=>{
    const html=renderToStaticMarkup(<Card>
      <Badge>ready</Badge>
      <Input aria-label="name" />
      <Textarea aria-label="notes" />
      <NativeSelect aria-label="mode"><option>Ask</option></NativeSelect>
      <Checkbox aria-label="assigned" />
      <TabsList><TabsTrigger active>Overview</TabsTrigger></TabsList>
      <Button>Save</Button>
    </Card>)
    for(const slot of ['card','badge','input','textarea','select','checkbox','tabs-list','tabs-trigger','button']){
      expect(html).toContain(`data-slot="${slot}"`)
    }
    expect(html).toContain('data-state="active"')
  })
  it('renders combobox, skeleton, and composable sidebar primitives',()=>{
    const html=renderToStaticMarkup(<>
      <Combobox value="daily" placeholder="Choose schedule" options={[{value:'daily',label:'Daily'}]} />
      <Skeleton />
      <SidebarProvider>
        <Sidebar><SidebarContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton isActive>Agent</SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarContent></Sidebar>
        <SidebarInset>Workspace</SidebarInset>
      </SidebarProvider>
    </>)
    expect(html).toContain('data-slot="combobox"')
    expect(html).toContain('data-slot="skeleton"')
    expect(html).toContain('data-slot="sidebar-wrapper"')
    expect(html).toContain('data-slot="sidebar"')
    expect(html).toContain('data-active="true"')
  })
})
