import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Badge, Button, Card, Checkbox, Input, NativeSelect, TabsList, TabsTrigger, Textarea } from './index.js'

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
})
