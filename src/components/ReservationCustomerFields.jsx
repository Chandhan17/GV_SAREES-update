const FIELDS = [
  { name: 'name', label: 'Full name', autoComplete: 'name' },
  { name: 'phone', label: 'Phone number', type: 'tel', inputMode: 'tel', autoComplete: 'tel' },
  { name: 'doorNo', label: 'House / door number', autoComplete: 'address-line1' },
  { name: 'streetName', label: 'Address / locality', autoComplete: 'address-line2' },
  { name: 'city', label: 'City', autoComplete: 'address-level2' },
  { name: 'pincode', label: 'PIN code', inputMode: 'numeric', autoComplete: 'postal-code' },
  { name: 'state', label: 'State', autoComplete: 'address-level1' },
]

export default function ReservationCustomerFields({
  customer,
  errors,
  touched,
  onChange,
  onBlur,
  disabled = false,
}) {
  return (
    <div className="space-y-3">
      {FIELDS.map((field) => {
        const error = touched[field.name] ? errors[field.name] : ''
        const errorId = `${field.name}-validation-error`
        return (
          <label key={field.name} className="block text-sm font-medium text-brand-dusty">
            {field.label}
            <input
              className="input-field mt-1"
              name={field.name}
              type={field.type || 'text'}
              inputMode={field.inputMode}
              autoComplete={field.autoComplete}
              value={customer[field.name]}
              onChange={(event) => onChange(field.name, event.target.value)}
              onBlur={() => onBlur(field.name)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              required
              disabled={disabled}
            />
            {error && <span id={errorId} className="mt-1 block text-xs text-red-700" role="alert">{error}</span>}
          </label>
        )
      })}
    </div>
  )
}
