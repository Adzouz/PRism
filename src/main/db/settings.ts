import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { Db } from './client'
import { settings } from './schema'

export function getSetting<T extends z.ZodType>(
  db: Db,
  key: string,
  schema: T,
  fallback: z.output<T>,
) {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return fallback
  const parsed = schema.safeParse(JSON.parse(row.valueJson))
  return parsed.success ? parsed.data : fallback
}

export function setSetting(db: Db, key: string, value: unknown) {
  const valueJson = JSON.stringify(value)
  db.insert(settings)
    .values({ key, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson } })
    .run()
}
