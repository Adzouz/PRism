import { create } from 'zustand'

type RepoFocus = {
  openRepoId: number | null
  scrollTo: number | null
  setOpen: (repoId: number | null) => void
  reveal: (repoId: number) => void
  scrolled: () => void
}

export const useRepoFocus = create<RepoFocus>()((set) => ({
  openRepoId: null,
  scrollTo: null,
  setOpen: (openRepoId) => set({ openRepoId }),
  reveal: (repoId) => set({ openRepoId: repoId, scrollTo: repoId }),
  scrolled: () => set({ scrollTo: null }),
}))
