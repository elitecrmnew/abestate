// datetime-local values are explicitly interpreted in IST, regardless of device timezone.
export function toISTInput(value: string | null): string {
  if (!value) return ''
  return new Date(new Date(value).getTime() + 330 * 60_000).toISOString().slice(0, 19)
}
export function fromISTInput(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('Enter a valid lead date and time.')
  const result = new Date(`${value}+05:30`)
  if (Number.isNaN(result.getTime()) || toISTInput(result.toISOString()).slice(0, value.length) !== value) throw new Error('Enter a valid lead date and time.')
  return result.toISOString()
}
