import { Combobox } from './components/ui/index.js'

export interface SelectOption { value: string; label: string; detail?: string }

export function SelectField({ name, label, options, placeholder, disabled = false }: {
  name: string
  label: string
  options: SelectOption[]
  placeholder: string
  disabled?: boolean
}) {
  return <label className="select-field"><span>{label}</span><Combobox name={name} options={options.map(option=>({...option,label:capitalize(option.label)}))} placeholder={placeholder} disabled={disabled}/></label>
}

function capitalize(value:string){return value.replace(/\b\w/g,character=>character.toUpperCase())}
