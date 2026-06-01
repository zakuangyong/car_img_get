import fs from 'fs'
import path from 'path'
import readline from 'readline'

export type ImageMeta = {
  id: string
  filePath: string
  brand?: string
  model?: string
  year?: number
  [k: string]: unknown
}

export type FilterOptions = {
  brands: string[]
  modelsByBrand: Record<string, string[]>
  yearsByBrandModel: Record<string, Record<string, number[]>>
}

type DatasetIndex = {
  datasetRoot: string
  metadataPath: string
  items: ImageMeta[]
  byId: Map<string, ImageMeta>
  filters: FilterOptions
}

const rxYear1 = /(19\d{2}|20\d{2})\s*款/
const rxYear2 = /\b(19\d{2}|20\d{2})\b/

function parseYear(specname: unknown): number | undefined {
  const s = String(specname ?? '').trim()
  const m = rxYear1.exec(s) ?? rxYear2.exec(s)
  if (!m) return undefined
  const y = Number(m[1])
  return Number.isFinite(y) ? y : undefined
}

function parseBrandModel(savedPath: unknown): { brand?: string; model?: string } {
  const p = String(savedPath ?? '')
  if (!p) return {}
  const parts = p.split('/').filter(Boolean)
  const specIdx = parts.findIndex((x) => /^spec_\d+$/.test(x))
  const cat = specIdx >= 0 ? parts[specIdx + 1] : ''
  if (!cat || cat.startsWith('view_')) return {}
  const us = cat.indexOf('_')
  if (us < 0) return { brand: cat }
  return { brand: cat.slice(0, us), model: cat.slice(us + 1) }
}

function toRelImagePath(datasetRoot: string, savedPath: unknown): string {
  const p = String(savedPath ?? '').replace(/\\/g, '/')
  if (!p) return ''
  if (p.startsWith('dataset_png/')) return p.slice('dataset_png/'.length)
  const idx = p.lastIndexOf('/series_')
  if (idx >= 0) return p.slice(idx + 1)
  const abs = path.isAbsolute(p) ? p : path.resolve(datasetRoot, p)
  const rel = path.relative(datasetRoot, abs).replace(/\\/g, '/')
  return rel.startsWith('../') ? '' : rel
}

function buildFilters(items: ImageMeta[]): FilterOptions {
  const brandSet = new Set<string>()
  const modelsByBrandSet: Record<string, Set<string>> = {}
  const yearsByBrandModelSet: Record<string, Record<string, Set<number>>> = {}

  for (const it of items) {
    const brand = String(it.brand ?? '').trim()
    const model = String(it.model ?? '').trim()
    const year = typeof it.year === 'number' ? it.year : undefined
    if (!brand) continue
    brandSet.add(brand)
    if (!modelsByBrandSet[brand]) modelsByBrandSet[brand] = new Set<string>()
    if (model) modelsByBrandSet[brand].add(model)
    if (!yearsByBrandModelSet[brand]) yearsByBrandModelSet[brand] = {}
    if (!yearsByBrandModelSet[brand][model]) yearsByBrandModelSet[brand][model] = new Set<number>()
    if (year !== undefined) yearsByBrandModelSet[brand][model].add(year)
  }

  const brands = Array.from(brandSet).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const modelsByBrand: Record<string, string[]> = {}
  const yearsByBrandModel: Record<string, Record<string, number[]>> = {}

  for (const b of brands) {
    const ms = Array.from(modelsByBrandSet[b] ?? []).sort((a, c) => a.localeCompare(c, 'zh-Hans-CN'))
    modelsByBrand[b] = ms
    yearsByBrandModel[b] = {}
    for (const m of ms) {
      const ys = Array.from(yearsByBrandModelSet[b]?.[m] ?? []).sort((x, y) => x - y)
      yearsByBrandModel[b][m] = ys
    }
  }

  return { brands, modelsByBrand, yearsByBrandModel }
}

let cache: DatasetIndex | null = null

export function resolveDatasetRoot(): string {
  const envRoot = String(process.env.DATASET_ROOT ?? '').trim()
  if (envRoot) return path.resolve(envRoot)
  return path.resolve(process.cwd(), '..', 'dataset_png')
}

export async function getDatasetIndex(): Promise<DatasetIndex> {
  const datasetRoot = resolveDatasetRoot()
  const metadataPath = path.resolve(datasetRoot, 'metadata.jsonl')

  if (cache && cache.datasetRoot === datasetRoot && cache.metadataPath === metadataPath) {
    return cache
  }

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`metadata.jsonl not found: ${metadataPath}`)
  }

  const items: ImageMeta[] = []
  const byId = new Map<string, ImageMeta>()

  const rl = readline.createInterface({
    input: fs.createReadStream(metadataPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  let i = 0
  for await (const line of rl) {
    const s = String(line ?? '').trim()
    if (!s) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(s) as Record<string, unknown>
    } catch {
      continue
    }
    const id = String(i + 1)
    const filePath = toRelImagePath(datasetRoot, rec.saved_path)
    if (!filePath) {
      i += 1
      continue
    }
    const { brand, model } = parseBrandModel(rec.saved_path)
    const year = parseYear(rec.specname)
    const meta: ImageMeta = {
      ...rec,
      id,
      filePath,
      brand,
      model,
      year,
    }
    items.push(meta)
    byId.set(id, meta)
    i += 1
  }

  const filters = buildFilters(items)
  cache = { datasetRoot, metadataPath, items, byId, filters }
  return cache
}

export function filterItems(
  items: ImageMeta[],
  q: { brand?: string; model?: string; year?: string },
): ImageMeta[] {
  const brand = String(q.brand ?? '').trim()
  const model = String(q.model ?? '').trim()
  const yearStr = String(q.year ?? '').trim()
  const year = yearStr ? Number(yearStr) : undefined

  return items.filter((it) => {
    if (brand && String(it.brand ?? '') !== brand) return false
    if (model && String(it.model ?? '') !== model) return false
    if (yearStr) {
      const y = typeof it.year === 'number' ? it.year : undefined
      if (y === undefined || y !== year) return false
    }
    return true
  })
}
