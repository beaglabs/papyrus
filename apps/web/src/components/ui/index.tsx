import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

function classes(...values:Array<string|false|null|undefined>){return values.filter(Boolean).join(' ')}

export type ButtonVariant='default'|'neutral'|'reverse'|'danger'|'ghost'
export const Button=forwardRef<HTMLButtonElement,ButtonHTMLAttributes<HTMLButtonElement>&{variant?:ButtonVariant;size?:'default'|'sm'|'icon'}>(
  ({className,variant,size,...props},ref)=>{
    const resolvedVariant=variant??(className?.includes('primary')?'default':className?.includes('danger')?'danger':className?.includes('text-button')?'ghost':'neutral')
    const resolvedSize=size??(className?.includes('icon-button')?'icon':'default')
    return <button ref={ref} data-slot="button" data-variant={resolvedVariant} data-size={resolvedSize} className={classes('nb-button',className)} {...props}/>
  }
)
Button.displayName='Button'

export const Input=forwardRef<HTMLInputElement,InputHTMLAttributes<HTMLInputElement>>(
  ({className,...props},ref)=><input ref={ref} data-slot="input" className={classes('nb-input',className)} {...props}/>
)
Input.displayName='Input'

export const Textarea=forwardRef<HTMLTextAreaElement,TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({className,...props},ref)=><textarea ref={ref} data-slot="textarea" className={classes('nb-textarea',className)} {...props}/>
)
Textarea.displayName='Textarea'

export const NativeSelect=forwardRef<HTMLSelectElement,SelectHTMLAttributes<HTMLSelectElement>>(
  ({className,...props},ref)=><select ref={ref} data-slot="select" className={classes('nb-select',className)} {...props}/>
)
NativeSelect.displayName='NativeSelect'

export const Checkbox=forwardRef<HTMLInputElement,Omit<InputHTMLAttributes<HTMLInputElement>,'type'>>(
  ({className,...props},ref)=><input ref={ref} type="checkbox" data-slot="checkbox" className={classes('nb-checkbox',className)} {...props}/>
)
Checkbox.displayName='Checkbox'

export function Label({className,...props}:LabelHTMLAttributes<HTMLLabelElement>){
  return <label data-slot="label" className={classes('nb-label',className)} {...props}/>
}

export function Card({className,...props}:HTMLAttributes<HTMLElement>){
  return <article data-slot="card" className={classes('nb-card',className)} {...props}/>
}
export function CardHeader({className,...props}:HTMLAttributes<HTMLDivElement>){
  return <div data-slot="card-header" className={classes('nb-card-header',className)} {...props}/>
}
export function CardContent({className,...props}:HTMLAttributes<HTMLDivElement>){
  return <div data-slot="card-content" className={classes('nb-card-content',className)} {...props}/>
}
export function Badge({className,...props}:HTMLAttributes<HTMLSpanElement>){
  return <span data-slot="badge" className={classes('nb-badge',className)} {...props}/>
}
export function Alert({className,...props}:HTMLAttributes<HTMLDivElement>){
  return <div role="alert" data-slot="alert" className={classes('nb-alert',className)} {...props}/>
}
export function EmptyState({title,description,action,className}:{title:string;description?:string;action?:ReactNode;className?:string}){
  return <Card className={classes('nb-empty-state',className)}><CardContent><span className="nb-empty-mark" aria-hidden="true">＋</span><h2>{title}</h2>{description&&<p>{description}</p>}{action}</CardContent></Card>
}
export function Avatar({className,...props}:HTMLAttributes<HTMLDivElement>){
  return <div data-slot="avatar" className={classes('nb-avatar',className)} {...props}/>
}
export function TabsList({className,...props}:HTMLAttributes<HTMLDivElement>){
  return <div role="tablist" data-slot="tabs-list" className={classes('nb-tabs-list',className)} {...props}/>
}
export function TabsTrigger({active=false,className,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{active?:boolean}){
  return <Button role="tab" aria-selected={active} data-slot="tabs-trigger" data-state={active?'active':'inactive'} className={className} {...props}/>
}

export interface ComboboxOption { value:string; label:string; detail?:string }
export function Combobox({name,value,defaultValue,options,placeholder,disabled=false,onValueChange,className}:{name?:string;value?:string;defaultValue?:string;options:ComboboxOption[];placeholder:string;disabled?:boolean;onValueChange?:(value:string)=>void;className?:string}){
  const [internal,setInternal]=useState(defaultValue??'')
  const [open,setOpen]=useState(false)
  const [query,setQuery]=useState('')
  const root=useRef<HTMLDivElement>(null)
  const selected=value??internal
  const selectedOption=options.find(option=>option.value===selected)
  const visible=options.filter(option=>(option.label+' '+(option.detail??'')).toLowerCase().includes(query.toLowerCase()))
  useEffect(()=>{const close=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false)};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close)},[])
  const choose=(next:string)=>{if(value===undefined)setInternal(next);onValueChange?.(next);setOpen(false);setQuery('')}
  return <div ref={root} data-slot="combobox" className={classes('nb-combobox',className)}>
    {name&&<input type="hidden" name={name} value={selected}/>}
    <Button type="button" variant="neutral" className="nb-combobox-trigger" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(current=>!current)}>
      <span>{selectedOption?.label??placeholder}</span><span aria-hidden="true">⌄</span>
    </Button>
    {open&&<div className="nb-combobox-popover">
      <Input autoFocus value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search…" aria-label="Filter options"/>
      <div role="listbox">{visible.length?visible.map(option=><Button type="button" variant="ghost" role="option" aria-selected={selected===option.value} key={option.value} onClick={()=>choose(option.value)}>
        <span>{option.label}</span>{option.detail&&<small>{option.detail}</small>}
      </Button>):<p>No options found.</p>}</div>
    </div>}
  </div>
}

export function Dialog({open,onOpenChange,children}:{open:boolean;onOpenChange:(open:boolean)=>void;children:ReactNode}){
  useEffect(()=>{if(!open)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')onOpenChange(false)};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape)},[open,onOpenChange])
  if(!open)return null
  return <div data-slot="dialog-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onOpenChange(false)}}><div role="dialog" aria-modal="true" data-slot="dialog">{children}</div></div>
}
export function DialogHeader({className,...props}:HTMLAttributes<HTMLDivElement>){return <div data-slot="dialog-header" className={className} {...props}/>}
export function DialogContent({className,...props}:HTMLAttributes<HTMLDivElement>){return <div data-slot="dialog-content" className={className} {...props}/>}
export function DialogFooter({className,...props}:HTMLAttributes<HTMLDivElement>){return <div data-slot="dialog-footer" className={className} {...props}/>}
