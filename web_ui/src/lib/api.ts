export type FiltersResponse = {
  brands: string[]
  modelsByBrand: Record<string, string[]>
  yearsByBrandModel: Record<string, Record<string, number[]>>
}

export type ImageListItem = {
  id: string
  filePath: string
  brand?: string
  model?: string
  year?: number
}

export type ImagesResponse = {
  total: number
  items: ImageListItem[]
}

export type ImageMeta = {
  id: string
  filePath: string
  brand?: string
  model?: string
  year?: number
  [k: string]: unknown
}

async function jsonFetch<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${r.status} ${r.statusText}${text ? `: ${text}` : ''}`)
  }
  return (await r.json()) as T
}

async function blobFetch(url: string, init?: RequestInit): Promise<Blob> {
  const r = await fetch(url, init)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${r.status} ${r.statusText}${text ? `: ${text}` : ''}`)
  }
  return await r.blob()
}

export function getFilters(): Promise<FiltersResponse> {
  return jsonFetch<FiltersResponse>('/api/filters')
}

export function getImages(q: {
  brand?: string
  model?: string
  year?: string
  page?: number
  pageSize?: number
}): Promise<ImagesResponse> {
  const sp = new URLSearchParams()
  if (q.brand) sp.set('brand', q.brand)
  if (q.model) sp.set('model', q.model)
  if (q.year) sp.set('year', q.year)
  sp.set('page', String(q.page ?? 1))
  sp.set('pageSize', String(q.pageSize ?? 60))
  return jsonFetch<ImagesResponse>(`/api/images?${sp.toString()}`)
}

export function getImage(id: string): Promise<ImageMeta> {
  return jsonFetch<ImageMeta>(`/api/images/${encodeURIComponent(id)}`)
}

export function getNav(id: string, q: { brand?: string; model?: string; year?: string }): Promise<{ prev: string | null; next: string | null; index: number; total: number }> {
  const sp = new URLSearchParams()
  if (q.brand) sp.set('brand', q.brand)
  if (q.model) sp.set('model', q.model)
  if (q.year) sp.set('year', q.year)
  return jsonFetch<{ prev: string | null; next: string | null; index: number; total: number }>(
    `/api/images/${encodeURIComponent(id)}/nav?${sp.toString()}`,
  )
}

export function imageUrl(filePath: string): string {
  return `/images/${encodeURI(filePath)}`
}

export async function downloadFileByUrl(url: string, filename: string): Promise<void> {
  const blob = await blobFetch(url)
  const urlObj = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = urlObj
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(urlObj)
  }
}
