import { create } from 'zustand'

export type SelectedImage = {
  id: string
  filePath: string
  brand?: string
  model?: string
  year?: number
}

type SelectionState = {
  selected: Record<string, SelectedImage>
  toggle: (img: SelectedImage) => void
  addMany: (imgs: SelectedImage[]) => void
  removeMany: (ids: string[]) => void
  clear: () => void
  count: () => number
  has: (id: string) => boolean
  ids: () => string[]
  values: () => SelectedImage[]
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selected: {},
  toggle: (img) =>
    set((s) => {
      const next = { ...s.selected }
      if (next[img.id]) delete next[img.id]
      else next[img.id] = img
      return { selected: next }
    }),
  addMany: (imgs) =>
    set((s) => {
      const next = { ...s.selected }
      for (const img of imgs) next[img.id] = img
      return { selected: next }
    }),
  removeMany: (ids) =>
    set((s) => {
      const next = { ...s.selected }
      for (const id of ids) delete next[id]
      return { selected: next }
    }),
  clear: () => set({ selected: {} }),
  count: () => Object.keys(get().selected).length,
  has: (id) => Boolean(get().selected[id]),
  ids: () => Object.keys(get().selected),
  values: () => Object.values(get().selected),
}))
