export interface SelectOption { value: string; label: string; detail?: string }
import { NativeSelect } from './components/ui/index.js'

export function SelectField({ name, label, options, placeholder, disabled = false }: {
  name: string
  label: string
  options: SelectOption[]
  placeholder: string
  disabled?: boolean
}) {
  const unavailable = disabled || options.length === 0
  return <label className="select-field">
    <span>{label}</span>
    <span className="select-control">
      <NativeSelect name={name} required defaultValue="" disabled={unavailable}>
        <option value="" disabled>{options.length ? placeholder : `No ${label.toLowerCase()} available`}</option>
        {options.map((option) => <option value={option.value} key={option.value}>{option.label}{option.detail ? ` — ${option.detail}` : ''}</option>)}
      </NativeSelect>
      <span aria-hidden="true">⌄</span>
    </span>
    {options.length === 0 && <small>Nothing eligible is available for this selection.</small>}
  </label>
}
