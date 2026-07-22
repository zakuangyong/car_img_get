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

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
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

export type CrawlJobStatus = 'running' | 'exited' | 'failed' | 'stopped'

export type CrawlJob = {
  id: string
  status: CrawlJobStatus
  startedAt: number
  endedAt?: number
  pid?: number
  exitCode?: number | null
  signal?: string | null
  args: string[]
  metrics: {
    accepted: number
    rejected: number
    errors: number
  }
}

export type PipelineModelStatus = {
  ready: boolean
  projectRoot: string
  datasetRoot: string
  stages: Array<{
    id: 'subject' | 'view' | 'clean'
    label: string
    ready: boolean
    path: string
    models?: string[]
  }>
}

export type CrawlJobListResponse = {
  items: CrawlJob[]
}

export type CrawlPreviewKind = 'accepted' | 'rejected'

export type CrawlPreviewItem = {
  id: string
  kind: CrawlPreviewKind
  imageUrl: string
  view?: string
  reason?: string
  confidence?: number
  specName?: string
  picId?: number
}

export type CrawlPreviewResponse = {
  items: CrawlPreviewItem[]
}

export type StartCrawlJobInput = {
  out: string
  category?: number
  minSize?: number
  minYear?: number
  maxYear?: number
  viewScheme?: string
  onlyView?: string
  viewBins?: string
  maxPerView?: number
  requiredViews?: string
  maxSeries?: number
  maxPerSeries?: number
  maxTotal?: number
  sleep?: number
  timeout?: number
  retries?: number
  prefer?: 'nowebppic' | 'originalpic'
  seriesFile?: string
  doneFile?: string
  preferYolo?: boolean
  onlyColors?: string
  maxColorsPerSpec?: number
  pagesize?: number
  qualityGate?: boolean
  keepStageImages?: boolean
  viewMinConf?: number
  cleanMinConf?: number
  maskThreshold?: number
  birefnetSize?: number
  device?: string
}

export function getPipelineModelStatus(): Promise<PipelineModelStatus> {
  return jsonFetch<PipelineModelStatus>('/api/crawl/pipeline-status')
}

export function listCrawlJobs(): Promise<CrawlJobListResponse> {
  return jsonFetch<CrawlJobListResponse>('/api/crawl/jobs')
}

export function getCrawlPreviews(
  outputRoot: string,
  kind: CrawlPreviewKind,
  limit = 8,
): Promise<CrawlPreviewResponse> {
  const query = new URLSearchParams({ out: outputRoot, kind, limit: String(limit) })
  return jsonFetch<CrawlPreviewResponse>(`/api/crawl/previews?${query.toString()}`)
}

export function startCrawlJob(input: StartCrawlJobInput): Promise<CrawlJob> {
  return jsonFetch<CrawlJob>('/api/crawl/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  } as RequestInit)
}

export function stopCrawlJob(id: string): Promise<CrawlJob> {
  return jsonFetch<CrawlJob>(`/api/crawl/jobs/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  } as RequestInit)
}

export type StorageTarget =
  | 'stage_original'
  | 'stage_birefnet'
  | 'stage_accepted'
  | 'stage_rejected'
  | 'review_rejected'
  | 'metadata'
  | 'rejected_manifest'
  | 'stage_part_files'

export type StorageAction = 'export' | 'cleanup' | 'delete' | 'backup'
export type StorageRisk = 'low' | 'medium' | 'high'
export type StorageJobStatus = 'running' | 'exited' | 'failed'

export type StorageSummaryItem = {
  target: StorageTarget
  kind: 'directory' | 'manifest' | 'virtual'
  label: string
  relativePath: string
  exists: boolean
  fileCount: number
  totalBytes: number
  latestMtimeMs?: number
  recordCount?: number
  warnings: string[]
}

export type StorageGroup = {
  key: string
  label: string
  fileCount: number
  totalBytes: number
}

export type StorageItemDetail = {
  target: StorageTarget
  summary: StorageSummaryItem
  groups: StorageGroup[]
  samples: Array<{ path: string; mtimeMs: number; size: number }>
  records?: Array<Record<string, unknown>>
}

export type StoragePlan = {
  planToken: string
  target: StorageTarget
  action: StorageAction
  risk: StorageRisk
  fileCount: number
  totalBytes: number
  samplePaths: string[]
  affectsPreview: boolean
  affectsHistory: boolean
  requiresTypedConfirmation: boolean
  confirmationText?: string
}

export type StorageJob = {
  id: string
  target: StorageTarget
  action: StorageAction
  status: StorageJobStatus
  startedAt: number
  endedAt?: number
  lines: string[]
}

export type StorageJobListItem = {
  id: string
  target: StorageTarget
  action: StorageAction
  status: StorageJobStatus
  startedAt: number
  endedAt?: number
}

export type StorageJobListResponse = {
  items: StorageJobListItem[]
}

export function getStorageSummary(out: string): Promise<{ root: string; items: StorageSummaryItem[] }> {
  return jsonFetch(`/api/crawl/storage/summary?${new URLSearchParams({ out }).toString()}`)
}

export function getStorageItems(out: string, target: StorageTarget): Promise<StorageItemDetail> {
  return jsonFetch(`/api/crawl/storage/items?${new URLSearchParams({ out, target }).toString()}`)
}

export function planStorageAction(input: {
  out: string
  target: StorageTarget
  action: StorageAction
  groupKey?: string
}): Promise<StoragePlan> {
  return jsonFetch('/api/crawl/storage/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  } as RequestInit)
}

export function executeStorageAction(input: {
  out: string
  planToken: string
  target: StorageTarget
  action: StorageAction
  confirmationText?: string
}): Promise<StorageJob> {
  return jsonFetch('/api/crawl/storage/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  } as RequestInit)
}

export function listStorageJobs(out?: string): Promise<StorageJobListResponse> {
  const query = out ? `?${new URLSearchParams({ out }).toString()}` : ''
  return jsonFetch(`/api/crawl/storage/jobs${query}`)
}
