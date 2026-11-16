import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Dashboard } from '@shared/domain'
import { cn } from '@/lib/utils'

const dayLabel = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })
const longDayLabel = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

function parseDay(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year!, month! - 1, date!)
}

export const formatDay = (day: string) => dayLabel.format(parseDay(day))
const formatLongDay = (day: string) => longDayLabel.format(parseDay(day))

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

function niceMax(value: number) {
  if (value <= 4) return 4
  const step = 10 ** Math.floor(Math.log10(value))
  const nice = [1, 2, 2.5, 5, 10].find((factor) => factor * step >= value) ?? 10
  return nice * step
}

function barPath(x: number, y: number, width: number, height: number) {
  const r = Math.min(4, width / 2, height)
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 80), width - 80)
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg"
      style={{ left }}
    >
      {children}
    </div>
  )
}

function Swatch({ className }: { className: string }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', className)} />
}

const series = [
  { key: 'opened', label: 'Opened', fill: 'fill-chart-1', bg: 'bg-chart-1' },
  { key: 'merged', label: 'Merged', fill: 'fill-chart-2', bg: 'bg-chart-2' },
  { key: 'closed', label: 'Closed', fill: 'fill-chart-3', bg: 'bg-chart-3' },
] as const

const plot = { top: 12, right: 4, bottom: 24, left: 32 }

function YAxis({ max, height, width }: { max: number; height: number; width: number }) {
  const inner = height - plot.top - plot.bottom
  return (
    <g className="text-[11px]">
      {[0, max / 2, max].map((tick) => {
        const y = plot.top + inner - (tick / max) * inner
        return (
          <g key={tick}>
            <line
              x1={plot.left}
              x2={width - plot.right}
              y1={y}
              y2={y}
              className={tick === 0 ? 'stroke-border' : 'stroke-border/60'}
              strokeDasharray={tick === 0 ? undefined : '2 4'}
            />
            <text
              x={plot.left - 8}
              y={y}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground tabular-nums"
            >
              {Number.isInteger(tick) ? tick : tick.toFixed(1)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

export function ActivityChart({ data }: { data: Dashboard['activity'] }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const height = 220
  const inner = {
    w: Math.max(0, width - plot.left - plot.right),
    h: height - plot.top - plot.bottom,
  }
  const max = niceMax(
    Math.max(0, ...data.flatMap((entry) => series.map(({ key }) => entry[key] ?? 0))),
  )
  const column = inner.w / Math.max(1, data.length)
  const bar = Math.max(3, Math.min(12, (column * 0.72 - 4) / 3))
  const group = bar * 3 + 4
  const labelEvery = column < 44 ? 2 : 1
  const totals = series.map(({ key }) =>
    data.reduce((total, entry) => total + (entry[key] ?? 0), 0),
  )
  const hovered = hover === null ? null : data[hover]

  return (
    <div className="relative space-y-4">
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {series.map(({ key, label, bg }, index) => (
          <li key={key} className="flex items-center gap-2">
            <Swatch className={bg} />
            <span className="text-muted-foreground">{label}</span>
            <span className="font-medium tabular-nums">{totals[index]}</span>
          </li>
        ))}
      </ul>
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="Pull requests per day">
            <YAxis max={max} height={height} width={width} />
            {data.map((entry, index) => {
              const x0 = plot.left + index * column
              const start = x0 + (column - group) / 2
              return (
                <g key={entry.day}>
                  {hover === index && (
                    <rect
                      x={x0 + 1}
                      y={plot.top}
                      width={column - 2}
                      height={inner.h}
                      rx={6}
                      className="fill-secondary"
                    />
                  )}
                  {series.map(({ key, fill }, position) => {
                    const value = entry[key] ?? 0
                    if (!value) return null
                    const h = (value / max) * inner.h
                    return (
                      <path
                        key={key}
                        d={barPath(start + position * (bar + 2), plot.top + inner.h - h, bar, h)}
                        className={fill}
                      />
                    )
                  })}
                  {index % labelEvery === (data.length - 1) % labelEvery && (
                    <text
                      x={x0 + column / 2}
                      y={height - 6}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[11px]"
                    >
                      {formatDay(entry.day)}
                    </text>
                  )}
                  <rect
                    x={x0}
                    y={0}
                    width={column}
                    height={height}
                    fill="transparent"
                    onMouseEnter={() => setHover(index)}
                  />
                </g>
              )
            })}
          </svg>
        )}
        {hovered && hover !== null && (
          <Tooltip x={plot.left + (hover + 0.5) * column} width={width}>
            <p className="mb-1.5 font-medium">{formatLongDay(hovered.day)}</p>
            {hovered.opened === null ? (
              <p className="text-muted-foreground">Not fetched yet</p>
            ) : (
              <ul className="space-y-1">
                {series.map(({ key, label, bg }) => (
                  <li key={key} className="flex items-center gap-2">
                    <Swatch className={bg} />
                    <span className="flex-1 text-muted-foreground">{label}</span>
                    <span className="pl-4 font-medium tabular-nums">{hovered[key]}</span>
                  </li>
                ))}
              </ul>
            )}
          </Tooltip>
        )}
      </div>
      <div className="sr-only">
        <table>
          <caption>Pull requests opened, merged and closed per day</caption>
          <thead>
            <tr>
              <th>Day</th>
              {series.map(({ key, label }) => (
                <th key={key}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((entry) => (
              <tr key={entry.day}>
                <td>{entry.day}</td>
                {series.map(({ key }) => (
                  <td key={key}>{entry[key] ?? 'unknown'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function TrendChart({ data }: { data: Dashboard['trend'] }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const height = 200
  const known = data.flatMap((entry, index) =>
    entry.openPrs === null ? [] : [{ index, value: entry.openPrs }],
  )
  const inner = {
    w: Math.max(0, width - plot.left - plot.right),
    h: height - plot.top - plot.bottom,
  }
  const low = Math.min(...known.map((point) => point.value))
  const high = Math.max(...known.map((point) => point.value))
  const pad = Math.max(1, Math.ceil((high - low) * 0.15))
  const floor = Math.max(0, low - pad)
  const span = Math.max(1, high + pad - floor)
  const step = inner.w / Math.max(1, data.length - 1)
  const x = (index: number) => plot.left + index * step
  const y = (value: number) => plot.top + inner.h - ((value - floor) / span) * inner.h

  const segments: { index: number; value: number }[][] = []
  for (const point of known) {
    const last = segments.at(-1)
    if (last && last.at(-1)!.index === point.index - 1) last.push(point)
    else segments.push([point])
  }
  const nearest =
    hover === null
      ? null
      : known.reduce<(typeof known)[number] | null>(
          (best, point) =>
            !best || Math.abs(point.index - hover) < Math.abs(best.index - hover) ? point : best,
          null,
        )
  const ticks = [floor, floor + span / 2, floor + span]

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Open pull requests per day"
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const index = Math.round((event.clientX - box.left - plot.left) / step)
            setHover(Math.min(data.length - 1, Math.max(0, index)))
          }}
        >
          <g className="text-[11px]">
            {ticks.map((tick, index) => (
              <g key={index}>
                <line
                  x1={plot.left}
                  x2={width - plot.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  className="stroke-border/60"
                  strokeDasharray="2 4"
                />
                <text
                  x={plot.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground tabular-nums"
                >
                  {Math.round(tick)}
                </text>
              </g>
            ))}
          </g>
          {[0, Math.floor((data.length - 1) / 2), data.length - 1].map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 6}
              textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}
              className="fill-muted-foreground text-[11px]"
            >
              {data[index] && formatDay(data[index].day)}
            </text>
          ))}
          {segments.map((segment) =>
            segment.length === 1 ? (
              <circle
                key={segment[0]!.index}
                cx={x(segment[0]!.index)}
                cy={y(segment[0]!.value)}
                r={3}
                className="fill-primary"
              />
            ) : (
              <path
                key={segment[0]!.index}
                d={`M${segment.map((point) => `${x(point.index)},${y(point.value)}`).join('L')}`}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-primary"
              />
            ),
          )}
          {nearest && (
            <g>
              <line
                x1={x(nearest.index)}
                x2={x(nearest.index)}
                y1={plot.top}
                y2={plot.top + inner.h}
                className="stroke-muted-foreground/40"
              />
              <circle
                cx={x(nearest.index)}
                cy={y(nearest.value)}
                r={4.5}
                strokeWidth={2}
                className="fill-primary stroke-surface"
              />
            </g>
          )}
        </svg>
      )}
      {nearest && (
        <Tooltip x={x(nearest.index)} width={width}>
          <p className="font-medium">{formatLongDay(data[nearest.index]!.day)}</p>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">{nearest.value}</span> open
          </p>
        </Tooltip>
      )}
      <div className="sr-only">
        <table>
          <caption>Open pull requests per day</caption>
          <tbody>
            {known.map((point) => (
              <tr key={point.index}>
                <td>{data[point.index]!.day}</td>
                <td>{point.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
