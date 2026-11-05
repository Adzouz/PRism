import type { Db } from '../db/client'

export type Ctx = {
  db: Db
  userData: string
  builtinSkillsDir: string
  log: (sourceId: number, chunk: string) => void
  skillsChanged: () => void
}
