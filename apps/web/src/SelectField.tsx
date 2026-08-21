export interface SelectOption { value: string; label: string; detail?: string }

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
      <select name={name} required defaultValue="" disabled={unavailable}>
        <option value="" disabled>{options.length ? placeholder : `No ${label.toLowerCase()} available`}</option>
        {options.map((option) => <option value={option.value} key={option.value}>{option.label}{option.detail ? ` — ${option.detail}` : ''}</option>)}
      </select>
      <span aria-hidden="true">⌄</span>
    </span>
    {options.length === 0 && <small>Nothing eligible is available for this selection.</small>}
  </label>
}
