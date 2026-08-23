import React, { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

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
export function EmptyState({title,description,action,className}:{title:string;description?:string;action?:React.ReactNode;className?:string}){
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
