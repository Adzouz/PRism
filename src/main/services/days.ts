const pad = (value: number) => String(value).padStart(2, '0')

export function localDay(ms: number) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parts(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return [year!, month! - 1, date!] as const
}

export function dayStart(day: string) {
  const [year, month, date] = parts(day)
  return new Date(year, month, date).getTime()
}

export function addDays(day: string, count: number) {
  const [year, month, date] = parts(day)
  return localDay(new Date(year, month, date + count).getTime())
}

export function lastDays(today: string, count: number) {
  return Array.from({ length: count }, (_, index) => addDays(today, index - count + 1))
}

function stamp(ms: number) {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${localDay(ms)}T${time}${zone}`
}

export const dayEnd = (day: string) => stamp(dayStart(addDays(day, 1)) - 1000)

export const dayRange = (day: string) => `${stamp(dayStart(day))}..${dayEnd(day)}`
