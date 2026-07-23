import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { StringDecoder } from 'string_decoder'

export type CrawlJobStatus = 'running' | 'exited' | 'failed' | 'stopped'

export type CrawlJobSummary = {
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

export type StorageTarget =
  | 'stage_original'
  | 'stage_birefnet'
  | 'stage_accepted'
  | 'stage_rejected'
  | 'review_rejected'
  | 'metadata'
  | 'rejected_manifest'
  | 'stage_part_files'

export type StorageRisk = 'low' | 'medium' | 'high'

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

export type StorageAction = 'export' | 'cleanup' | 'delete' | 'backup'

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

export type StorageJobStatus = 'running' | 'exited' | 'failed'

export type StorageJobSummary = {
  id: string
  target: StorageTarget
  action: StorageAction
  status: StorageJobStatus
  startedAt: number
  endedAt?: number
  lines: string[]
}

export type StorageJobListItem = Omit<StorageJobSummary, 'lines'>

type PreviewRecord = Record<string, unknown>

type StorageManagedFile = {
  absolutePath: string
  relativePath: string
  targetRelativePath: string
  size: number
  mtimeMs: number
}

type StoredStoragePlan = StoragePlan & {
  root: string
  groupKey?: string
  files: StorageManagedFile[]
  createdAt: number
  expiresAt: number
}

type Listener = (line: string) => void

type CrawlJob = CrawlJobSummary & {
  proc?: ChildProcessWithoutNullStreams
  logPath: string
  lines: string[]
  listeners: Set<Listener>
}

type StorageJob = StorageJobSummary & {
  root: string
  listeners: Set<Listener>
}

const MAX_LINES = 2500
const PREVIEW_RECORD_LOOKBACK = 1000
const PREVIEW_RECORD_CACHE_LIMIT = 512
const STORAGE_RECORD_LOOKBACK = 20
const STORAGE_SAMPLE_LIMIT = 20
const STORAGE_PLAN_SAMPLE_LIMIT = 5
const DEFAULT_STORAGE_PLAN_TTL_MS = 5 * 60 * 1000
const STORAGE_JOB_BATCH_SIZE = 4
const jobs = new Map<string, CrawlJob>()
const previewRecordCache = new Map<string, PreviewRecord>()
const storagePlans = new Map<string, StoredStoragePlan>()
const storageJobs = new Map<string, StorageJob>()
const STORAGE_TARGETS: Array<{
  target: StorageTarget
  kind: 'directory' | 'manifest' | 'virtual'
  label: string
  relativePath: string
}> = [
  { target: 'stage_original', kind: 'directory', label: 'Original', relativePath: '_pipeline_stages/original' },
  { target: 'stage_birefnet', kind: 'directory', label: 'BiRefNet', relativePath: '_pipeline_stages/birefnet' },
  { target: 'stage_accepted', kind: 'directory', label: 'Accepted', relativePath: '_pipeline_stages/accepted' },
  { target: 'stage_rejected', kind: 'directory', label: 'Rejected', relativePath: '_pipeline_stages/rejected' },
  { target: 'review_rejected', kind: 'directory', label: 'Review Rejected', relativePath: '_review/rejected' },
  { target: 'metadata', kind: 'manifest', label: 'metadata.jsonl', relativePath: 'metadata.jsonl' },
  { target: 'rejected_manifest', kind: 'manifest', label: 'rejected.jsonl', relativePath: 'rejected.jsonl' },
  { target: 'stage_part_files', kind: 'virtual', label: '.part residuals', relativePath: '_pipeline_stages' },
]
const STORAGE_TARGET_ACTIONS: Record<StorageTarget, StorageAction[]> = {
  stage_original: ['export', 'delete'],
  stage_birefnet: ['export', 'delete'],
  stage_accepted: ['export', 'delete'],
  stage_rejected: ['export', 'cleanup', 'delete'],
  review_rejected: ['export', 'cleanup'],
  metadata: ['export', 'backup'],
  rejected_manifest: ['export', 'backup'],
  stage_part_files: ['export', 'cleanup'],
}

function getLogDir(): string {
  const env = String(process.env.CRAWLER_LOG_DIR ?? '').trim()
  return env ? path.resolve(env) : path.resolve(process.cwd(), 'run', 'crawl_jobs')
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true })
}

function pushLine(job: CrawlJob, line: string) {
  if (line.includes('[saved]')) job.metrics.accepted += 1
  if (line.includes('[rejected]')) job.metrics.rejected += 1
  if (line.includes('Traceback') || line.includes('ERROR') || line.includes('spawn error')) job.metrics.errors += 1
  job.lines.push(line)
  if (job.lines.length > MAX_LINES) {
    job.lines.splice(0, job.lines.length - MAX_LINES)
  }
  for (const cb of job.listeners) cb(line)
}

function formatLine(src: 'stdout' | 'stderr', line: string): string {
  const t = new Date().toISOString()
  const tag = src === 'stdout' ? 'LOG' : 'MSG'
  return `${t} ${tag} ${line}`
}

function buildArgs(input: Record<string, unknown>): string[] {
  const out = ['-m', 'car_img_get.download_autohome_many']

  function add(k: string, v: unknown) {
    if (v === undefined || v === null) return
    const s = String(v).trim()
    if (!s) return
    out.push(k, s)
  }

  function addNum(k: string, v: unknown) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return
    out.push(k, String(Math.floor(n)))
  }

  add('--out', input.out)
  addNum('--category', input.category)
  addNum('--pagesize', input.pagesize)
  addNum('--max-series', input.maxSeries)
  addNum('--max-per-series', input.maxPerSeries)
  addNum('--max-total', input.maxTotal)
  addNum('--min-size', input.minSize)
  addNum('--min-year', input.minYear)
  addNum('--max-year', input.maxYear)
  add('--only-colors', input.onlyColors)
  addNum('--max-colors-per-spec', input.maxColorsPerSpec)

  const sleep = Number(input.sleep)
  if (Number.isFinite(sleep) && sleep > 0) out.push('--sleep', String(sleep))

  const timeout = Number(input.timeout)
  if (Number.isFinite(timeout) && timeout > 0) out.push('--timeout', String(timeout))

  addNum('--retries', input.retries)
  add('--prefer', input.prefer)
  add('--series-file', input.seriesFile)
  add('--done-file', input.doneFile)
  add('--view-scheme', input.viewScheme)
  if (input.preferYolo) out.push('--prefer-yolo')
  add('--view-min-conf', input.viewMinConf)
  add('--clean-min-conf', input.cleanMinConf)
  add('--mask-threshold', input.maskThreshold)
  addNum('--birefnet-size', input.birefnetSize)
  add('--device', input.device)
  if (input.qualityGate === false) out.push('--no-quality-gate')
  if (input.keepStageImages === false) out.push('--no-keep-stage-images')
  add('--only-view', input.onlyView)
  add('--view-bins', input.viewBins)
  addNum('--max-per-view', input.maxPerView)
  add('--required-views', input.requiredViews)

  return out
}

function resolvePythonBin(): string {
  const s = String(process.env.CRAWLER_PYTHON ?? '').trim()
  if (s) return s
  return process.platform === 'win32' ? 'python' : 'python3'
}

function resolveProjectRoot(): string {
  const s = String(process.env.CRAWLER_PROJECT_ROOT ?? '').trim()
  if (s) return path.resolve(s)
  const cwd = process.cwd()
  const candidates = [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '..', '..')]
  for (const c of candidates) {
    if (fs.existsSync(path.resolve(c, 'car_img_get'))) return c
  }
  return path.resolve(cwd, '..')
}

function resolveDatasetRoot(): string {
  const value = String(process.env.DATASET_ROOT ?? '').trim()
  return value ? path.resolve(value) : path.resolve(resolveProjectRoot(), 'dataset_png')
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolvePreviewRoot(value: unknown): string {
  const raw = String(value ?? '').trim()
  const projectRoot = resolveProjectRoot()
  const datasetRoot = resolveDatasetRoot()
  const resolved = raw ? (path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw)) : datasetRoot
  if (!isPathInside(projectRoot, resolved) && !isPathInside(datasetRoot, resolved)) {
    throw new Error('preview output directory is outside the configured project and dataset roots')
  }
  return resolved
}

function walkFiles(dirPath: string, visit: (filePath: string, stat: fs.Stats) => void) {
  if (!fs.existsSync(dirPath)) return
  const stack = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.resolve(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      visit(entryPath, fs.statSync(entryPath))
    }
  }
}

function formatScanWarning(scope: string, targetPath: string, error: unknown): string {
  const issue = error as NodeJS.ErrnoException
  const code = String(issue?.code ?? 'UNKNOWN')
  const message = String(issue?.message ?? error)
  return `${scope} ${targetPath} failed: [${code}] ${message}`
}

function walkFilesSafely(
  dirPath: string,
  warnings: string[],
  visit: (filePath: string, stat: fs.Stats) => void,
) {
  if (!fs.existsSync(dirPath)) return
  const stack = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      warnings.push(formatScanWarning('readdir', current, error))
      continue
    }
    for (const entry of entries) {
      const entryPath = path.resolve(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      try {
        visit(entryPath, fs.statSync(entryPath))
      } catch (error) {
        warnings.push(formatScanWarning('stat', entryPath, error))
      }
    }
  }
}

function countJsonlLines(filePath: string): { count: number; warnings: string[] } {
  if (!fs.existsSync(filePath)) return { count: 0, warnings: [] }
  const warnings: string[] = []
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (error) {
    return { count: 0, warnings: [formatScanWarning('stat', filePath, error)] }
  }
  if (!stat.isFile() || stat.size <= 0) return { count: 0, warnings }
  let handle: number
  try {
    handle = fs.openSync(filePath, 'r')
  } catch (error) {
    return { count: 0, warnings: [formatScanWarning('open', filePath, error)] }
  }
  const buffer = Buffer.alloc(64 * 1024)
  const decoder = new StringDecoder('utf8')
  let count = 0
  let rest = ''

  function consumeLine(line: string, isTail: boolean) {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      JSON.parse(trimmed)
      count += 1
    } catch (error) {
      const suffix = isTail ? 'tail line' : 'line'
      warnings.push(formatScanWarning(`jsonl ${suffix}`, filePath, error))
    }
  }

  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      const lines = (rest + decoder.write(buffer.subarray(0, bytesRead))).split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const line of lines) {
        consumeLine(line, false)
      }
    }
    rest += decoder.end()
  } catch (error) {
    warnings.push(formatScanWarning('read', filePath, error))
  } finally {
    fs.closeSync(handle)
  }
  consumeLine(rest, true)
  return { count, warnings }
}

function buildStorageSummaryItem(
  root: string,
  target: (typeof STORAGE_TARGETS)[number],
): StorageSummaryItem {
  if (target.kind === 'manifest') return scanManifestSummary(root, target)
  if (target.kind === 'virtual') return scanPartFilesSummary(root, target)
  return scanDirectorySummary(root, target)
}

function scanDirectorySummary(root: string, target: (typeof STORAGE_TARGETS)[number]): StorageSummaryItem {
  const dirPath = path.resolve(root, target.relativePath)
  const summary: StorageSummaryItem = {
    target: target.target,
    kind: target.kind,
    label: target.label,
    relativePath: target.relativePath,
    exists: fs.existsSync(dirPath),
    fileCount: 0,
    totalBytes: 0,
    warnings: [],
  }
  if (!summary.exists) return summary
  walkFilesSafely(dirPath, summary.warnings, (filePath, stat) => {
    if (filePath.endsWith('.part')) return
    summary.fileCount += 1
    summary.totalBytes += stat.size
    summary.latestMtimeMs = Math.max(summary.latestMtimeMs ?? 0, stat.mtimeMs)
  })
  return summary
}

function scanPartFilesSummary(root: string, target: (typeof STORAGE_TARGETS)[number]): StorageSummaryItem {
  const dirPath = path.resolve(root, target.relativePath)
  const summary: StorageSummaryItem = {
    target: target.target,
    kind: target.kind,
    label: target.label,
    relativePath: target.relativePath,
    exists: fs.existsSync(dirPath),
    fileCount: 0,
    totalBytes: 0,
    warnings: [],
  }
  if (!summary.exists) return summary
  walkFilesSafely(dirPath, summary.warnings, (filePath, stat) => {
    if (!filePath.endsWith('.part')) return
    summary.fileCount += 1
    summary.totalBytes += stat.size
    summary.latestMtimeMs = Math.max(summary.latestMtimeMs ?? 0, stat.mtimeMs)
  })
  return summary
}

function scanManifestSummary(root: string, target: (typeof STORAGE_TARGETS)[number]): StorageSummaryItem {
  const filePath = path.resolve(root, target.relativePath)
  const exists = fs.existsSync(filePath)
  let stat: fs.Stats | null = null
  const warnings: string[] = []
  if (exists) {
    try {
      stat = fs.statSync(filePath)
    } catch (error) {
      warnings.push(formatScanWarning('stat', filePath, error))
    }
  }
  const isRegularFile = Boolean(stat?.isFile())
  if (exists && stat && !isRegularFile) {
    warnings.push(`manifest ${filePath} is not a regular file`)
  }
  const recordSummary = isRegularFile ? countJsonlLines(filePath) : { count: 0, warnings: [] }
  warnings.push(...recordSummary.warnings)
  return {
    target: target.target,
    kind: target.kind,
    label: target.label,
    relativePath: target.relativePath,
    exists,
    fileCount: isRegularFile ? 1 : 0,
    totalBytes: isRegularFile ? (stat?.size ?? 0) : 0,
    latestMtimeMs: isRegularFile ? stat?.mtimeMs : undefined,
    recordCount: recordSummary.count,
    warnings,
  }
}

export function getStorageSummary(outputRoot: string): { root: string; items: StorageSummaryItem[] } {
  const root = resolvePreviewRoot(outputRoot)
  return {
    root,
    items: STORAGE_TARGETS.map((target) => buildStorageSummaryItem(root, target)),
  }
}

function getStorageTargetDefinition(target: StorageTarget): (typeof STORAGE_TARGETS)[number] {
  const definition = STORAGE_TARGETS.find((item) => item.target === target)
  if (!definition) throw new Error(`unknown storage target: ${target}`)
  return definition
}

function normalizeStoragePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function buildStorageSample(files: StorageManagedFile[]): StorageItemDetail['samples'] {
  return files.slice(0, STORAGE_SAMPLE_LIMIT).map((file) => ({
    path: file.relativePath,
    mtimeMs: file.mtimeMs,
    size: file.size,
  }))
}

function buildStorageGroups(files: StorageManagedFile[], resolveKey: (file: StorageManagedFile) => string): StorageGroup[] {
  const groups = new Map<string, StorageGroup>()
  for (const file of files) {
    const key = resolveKey(file)
    const existing = groups.get(key)
    if (existing) {
      existing.fileCount += 1
      existing.totalBytes += file.size
      continue
    }
    groups.set(key, {
      key,
      label: key === '(root)' ? 'Root' : key.split('/').join(' / '),
      fileCount: 1,
      totalBytes: file.size,
    })
  }
  return Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key))
}

function getStorageGroupKey(target: StorageTarget, file: StorageManagedFile): string {
  const segments = file.targetRelativePath.split('/').filter(Boolean)
  if (target === 'stage_rejected') {
    const view = segments[0] || 'unknown'
    const reason = segments[1] || 'unknown'
    return `${view}/${reason}`
  }
  return segments[0] || '(root)'
}

function normalizeRequestedGroupKey(groupKey: string | undefined): string | undefined {
  if (groupKey === undefined) return undefined
  const raw = String(groupKey)
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('groupKey must not be blank')
  if (trimmed !== raw) throw new Error('groupKey must match an exact visible group key')
  return trimmed
}

function assertStorageActionAllowed(target: StorageTarget, action: StorageAction) {
  if (STORAGE_TARGET_ACTIONS[target].includes(action)) return
  throw new Error(`action ${action} is not allowed for ${target}`)
}

function assertStorageGroupActionAllowed(target: StorageTarget, action: StorageAction, groupKey?: string) {
  if (groupKey === undefined) return
  if (action === 'export') return
  if (target === 'stage_rejected' && action === 'cleanup') return
  throw new Error(`group-scoped action ${action} is not allowed for ${target}`)
}

function sortManagedFiles(files: StorageManagedFile[]): StorageManagedFile[] {
  return files.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
    return a.relativePath.localeCompare(b.relativePath)
  })
}

function getStoragePlanTtlMs(): number {
  const value = Number(process.env.CRAWLER_STORAGE_PLAN_TTL_MS)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_STORAGE_PLAN_TTL_MS
}

function cleanupExpiredStoragePlans(now = Date.now(), skipToken?: string) {
  for (const [planToken, plan] of storagePlans.entries()) {
    if (planToken === skipToken) continue
    if (plan.expiresAt <= now) storagePlans.delete(planToken)
  }
}

function collectDirectoryFiles(
  root: string,
  targetRoot: string,
  scanRoot: string,
  include: (filePath: string) => boolean,
): StorageManagedFile[] {
  const files: StorageManagedFile[] = []
  if (!fs.existsSync(scanRoot)) return files
  walkFilesSafely(scanRoot, [], (filePath, stat) => {
    if (!include(filePath)) return
    files.push({
      absolutePath: filePath,
      relativePath: normalizeStoragePath(path.relative(root, filePath)),
      targetRelativePath: normalizeStoragePath(path.relative(targetRoot, filePath)),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })
  })
  return sortManagedFiles(files)
}

function collectManagedFiles(root: string, target: StorageTarget, groupKey?: string): StorageManagedFile[] {
  const definition = getStorageTargetDefinition(target)
  const requestedGroupKey = normalizeRequestedGroupKey(groupKey)
  if (definition.kind === 'manifest') {
    if (requestedGroupKey !== undefined) throw new Error(`groupKey is not supported for ${target}`)
    const filePath = path.resolve(root, definition.relativePath)
    if (!fs.existsSync(filePath)) return []
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return []
    return [
      {
        absolutePath: filePath,
        relativePath: normalizeStoragePath(path.relative(root, filePath)),
        targetRelativePath: normalizeStoragePath(definition.relativePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      },
    ]
  }

  const targetRoot = path.resolve(root, definition.relativePath)
  if (definition.kind === 'virtual') {
    if (requestedGroupKey !== undefined) throw new Error(`groupKey is not supported for ${target}`)
    return collectDirectoryFiles(root, targetRoot, targetRoot, (filePath) => filePath.endsWith('.part'))
  }

  const files = collectDirectoryFiles(root, targetRoot, targetRoot, (filePath) => !filePath.endsWith('.part'))
  if (requestedGroupKey === undefined) return files
  const visibleGroupKeys = new Set(files.map((file) => getStorageGroupKey(target, file)))
  if (!visibleGroupKeys.has(requestedGroupKey)) {
    throw new Error(`groupKey must match a current visible group for ${target}`)
  }
  return files.filter((file) => getStorageGroupKey(target, file) === requestedGroupKey)
}

function buildDirectoryDetail(root: string, summary: StorageSummaryItem): StorageItemDetail {
  const files = collectManagedFiles(root, summary.target)
  return {
    target: summary.target,
    summary,
    groups: buildStorageGroups(files, (file) => getStorageGroupKey(summary.target, file)),
    samples: buildStorageSample(files),
  }
}

function buildRejectedDetail(root: string, summary: StorageSummaryItem): StorageItemDetail {
  const files = collectManagedFiles(root, summary.target)
  return {
    target: summary.target,
    summary,
    groups: buildStorageGroups(files, (file) => getStorageGroupKey(summary.target, file)),
    samples: buildStorageSample(files),
  }
}

function buildManifestDetail(root: string, summary: StorageSummaryItem): StorageItemDetail {
  const filePath = path.resolve(root, summary.relativePath)
  const records = readJsonlTail(filePath, STORAGE_RECORD_LOOKBACK).reverse()
  return {
    target: summary.target,
    summary,
    groups:
      summary.recordCount === undefined
        ? []
        : [{ key: 'records', label: 'Records', fileCount: summary.recordCount, totalBytes: summary.totalBytes }],
    samples: summary.exists
      ? [
          {
            path: normalizeStoragePath(summary.relativePath),
            mtimeMs: summary.latestMtimeMs ?? 0,
            size: summary.totalBytes,
          },
        ]
      : [],
    records,
  }
}

export function getStorageItems(outputRoot: string, target: StorageTarget): StorageItemDetail {
  const root = resolvePreviewRoot(outputRoot)
  const summary = getStorageSummary(root).items.find((item) => item.target === target)
  if (!summary) throw new Error(`unknown storage target: ${target}`)
  if (target === 'stage_rejected') return buildRejectedDetail(root, summary)
  if (target === 'metadata' || target === 'rejected_manifest') return buildManifestDetail(root, summary)
  return buildDirectoryDetail(root, summary)
}

function resolveStorageRisk(target: StorageTarget, action: StorageAction): StorageRisk {
  if (action === 'backup' || action === 'export') return 'low'
  if (target === 'review_rejected' || target === 'stage_part_files') return 'low'
  if (target === 'stage_accepted' || target === 'metadata' || target === 'rejected_manifest') return 'high'
  return 'medium'
}

function resolveStorageConfirmationText(
  target: StorageTarget,
  action: StorageAction,
  risk: StorageRisk,
): string | undefined {
  if (action !== 'delete' || risk !== 'high') return undefined
  if (target === 'stage_accepted') return 'DELETE_ACCEPTED'
  if (target === 'metadata' || target === 'rejected_manifest') return 'DELETE_HISTORY'
  return 'DELETE_ALL_STAGES'
}

export function planStorageAction(
  outputRoot: string,
  input: { target: StorageTarget; action: StorageAction; groupKey?: string },
): StoragePlan {
  const now = Date.now()
  cleanupExpiredStoragePlans(now)
  const root = resolvePreviewRoot(outputRoot)
  const groupKey = normalizeRequestedGroupKey(input.groupKey)
  assertStorageActionAllowed(input.target, input.action)
  assertStorageGroupActionAllowed(input.target, input.action, groupKey)
  const files = collectManagedFiles(root, input.target, groupKey)
  const risk = resolveStorageRisk(input.target, input.action)
  const requiresTypedConfirmation = input.action === 'delete' && risk === 'high'
  const planToken = randomUUID()
  const ttlMs = getStoragePlanTtlMs()
  const plan: StoragePlan = {
    planToken,
    target: input.target,
    action: input.action,
    risk,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    samplePaths: files.slice(0, STORAGE_PLAN_SAMPLE_LIMIT).map((file) => file.relativePath),
    affectsPreview:
      input.target === 'stage_accepted' || input.target === 'stage_rejected' || input.target === 'review_rejected',
    affectsHistory: input.target === 'metadata' || input.target === 'rejected_manifest',
    requiresTypedConfirmation,
    confirmationText: resolveStorageConfirmationText(input.target, input.action, risk),
  }
  storagePlans.set(planToken, {
    ...plan,
    root,
    groupKey,
    files: files.map((file) => ({ ...file })),
    createdAt: now,
    expiresAt: now + ttlMs,
  })
  return plan
}

function toStorageJobSummary(job: StorageJob): StorageJobSummary {
  return {
    id: job.id,
    target: job.target,
    action: job.action,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    lines: job.lines.slice(),
  }
}

function toStorageJobListItem(job: StorageJob): StorageJobListItem {
  return {
    id: job.id,
    target: job.target,
    action: job.action,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  }
}

function pushStorageJobLine(job: StorageJob, line: string) {
  job.lines.push(line)
  if (job.lines.length > MAX_LINES) {
    job.lines.splice(0, job.lines.length - MAX_LINES)
  }
  for (const listener of job.listeners) listener(line)
}

function emitStorageJobLine(job: StorageJob, src: 'stdout' | 'stderr', line: string) {
  const clean = String(line ?? '').replace(/\s+$/g, '')
  if (!clean) return
  pushStorageJobLine(job, formatLine(src, clean))
}

function finishStorageJob(job: StorageJob, status: StorageJobStatus, line: string) {
  job.status = status
  job.endedAt = Date.now()
  emitStorageJobLine(job, status === 'failed' ? 'stderr' : 'stdout', line)
}

function createStorageJob(id: string, plan: StoredStoragePlan): StorageJob {
  const job: StorageJob = {
    id,
    root: plan.root,
    target: plan.target,
    action: plan.action,
    status: 'running',
    startedAt: Date.now(),
    lines: [],
    listeners: new Set(),
  }
  storageJobs.set(id, job)
  return job
}

function getStorageJobBoundary(root: string, target: StorageTarget): string {
  const definition = getStorageTargetDefinition(target)
  if (definition.kind === 'manifest') return root
  return path.resolve(root, definition.relativePath)
}

function pruneEmptyDirectories(startPath: string, boundary: string) {
  let current = path.dirname(startPath)
  const stopAt = path.resolve(boundary)
  while (isPathInside(stopAt, current) && current !== stopAt) {
    let entries: string[]
    try {
      entries = fs.readdirSync(current)
    } catch {
      return
    }
    if (entries.length > 0) return
    try {
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

function shouldYieldStorageJob(index: number): boolean {
  return index > 0 && index % STORAGE_JOB_BATCH_SIZE === 0
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

async function deleteStorageFiles(plan: StoredStoragePlan, job: StorageJob): Promise<number> {
  const boundary = getStorageJobBoundary(plan.root, plan.target)
  let processed = 0
  for (let index = 0; index < plan.files.length; index += 1) {
    if (shouldYieldStorageJob(index)) await yieldToEventLoop()
    const file = plan.files[index] as StorageManagedFile
    if (!fs.existsSync(file.absolutePath)) {
      emitStorageJobLine(job, 'stderr', `missing file skipped: ${file.relativePath}`)
      continue
    }
    await fs.promises.rm(file.absolutePath, { force: true })
    pruneEmptyDirectories(file.absolutePath, boundary)
    processed += 1
    emitStorageJobLine(job, 'stdout', `removed ${file.relativePath}`)
  }
  return processed
}

async function copyStorageFiles(plan: StoredStoragePlan, job: StorageJob, baseDir: string): Promise<number> {
  let processed = 0
  for (let index = 0; index < plan.files.length; index += 1) {
    if (shouldYieldStorageJob(index)) await yieldToEventLoop()
    const file = plan.files[index] as StorageManagedFile
    if (!fs.existsSync(file.absolutePath)) {
      emitStorageJobLine(job, 'stderr', `missing file skipped: ${file.relativePath}`)
      continue
    }
    const destination = path.resolve(baseDir, file.relativePath)
    ensureDir(path.dirname(destination))
    await fs.promises.copyFile(file.absolutePath, destination)
    processed += 1
    emitStorageJobLine(job, 'stdout', `copied ${file.relativePath} -> ${normalizeStoragePath(path.relative(plan.root, destination))}`)
  }
  return processed
}

async function performStorageAction(plan: StoredStoragePlan, job: StorageJob): Promise<number> {
  if (plan.action === 'cleanup' || plan.action === 'delete') {
    return deleteStorageFiles(plan, job)
  }
  if (plan.action === 'export') {
    const exportRoot = path.resolve(plan.root, '_management_exports', `${Date.now()}-${plan.target}-${job.id}`)
    emitStorageJobLine(job, 'stdout', `export destination ${normalizeStoragePath(path.relative(plan.root, exportRoot))}`)
    return copyStorageFiles(plan, job, exportRoot)
  }
  if (plan.action === 'backup') {
    const backupRoot = path.resolve(plan.root, '_management_backups', `${Date.now()}-${plan.target}-${job.id}`)
    emitStorageJobLine(job, 'stdout', `backup destination ${normalizeStoragePath(path.relative(plan.root, backupRoot))}`)
    return copyStorageFiles(plan, job, backupRoot)
  }
  throw new Error(`unsupported storage action: ${plan.action satisfies never}`)
}

async function runStorageJob(plan: StoredStoragePlan, job: StorageJob) {
  emitStorageJobLine(
    job,
    'stderr',
    `job started action=${plan.action} target=${plan.target} planned=${plan.fileCount} risk=${plan.risk}`,
  )
  try {
    const processed = await performStorageAction(plan, job)
    finishStorageJob(job, 'exited', `job finished status=exited processed=${processed}`)
  } catch (error) {
    finishStorageJob(job, 'failed', `job finished status=failed error=${String((error as Error)?.message ?? error)}`)
  }
}

export function executeStorageAction(
  outputRoot: string,
  input: { planToken: string; target: StorageTarget; action: StorageAction; confirmationText?: string },
): StorageJobSummary {
  const now = Date.now()
  const root = resolvePreviewRoot(outputRoot)
  const planToken = String(input.planToken ?? '')
  const plan = storagePlans.get(planToken)
  cleanupExpiredStoragePlans(now, planToken)
  if (!plan) throw new Error('storage plan not found')
  if (plan.expiresAt <= now) {
    storagePlans.delete(planToken)
    throw new Error('storage plan expired')
  }
  if (plan.root !== root) throw new Error('storage plan does not match output root')
  if (plan.target !== input.target || plan.action !== input.action) {
    throw new Error('storage plan does not match request')
  }
  if (plan.requiresTypedConfirmation && input.confirmationText !== plan.confirmationText) {
    throw new Error('typed confirmation mismatch')
  }

  storagePlans.delete(plan.planToken)
  const id = randomUUID()
  const job = createStorageJob(id, plan)
  setImmediate(() => {
    void runStorageJob(plan, job)
  })
  return toStorageJobSummary(job)
}

function requireStorageOutputRoot(outputRoot: unknown): string {
  if (outputRoot === undefined) throw new Error('out is required')
  const raw = String(outputRoot).trim()
  if (!raw) throw new Error('out is required')
  return resolvePreviewRoot(raw)
}

function matchesStorageJobRoot(job: StorageJob, outputRoot: string): boolean {
  return job.root === outputRoot
}

export function listStorageJobs(outputRoot: unknown): { items: StorageJobListItem[] } {
  const requestedRoot = requireStorageOutputRoot(outputRoot)
  return {
    items: Array.from(storageJobs.values())
      .filter((job) => matchesStorageJobRoot(job, requestedRoot))
      .map((job) => toStorageJobListItem(job))
      .sort((a, b) => b.startedAt - a.startedAt),
  }
}

export function getStorageJob(id: string, outputRoot: unknown): StorageJobSummary | null {
  const requestedRoot = requireStorageOutputRoot(outputRoot)
  const job = storageJobs.get(id)
  if (!job || !matchesStorageJobRoot(job, requestedRoot)) return null
  return toStorageJobSummary(job)
}

export function subscribeStorageJob(id: string, cb: Listener, outputRoot: unknown): (() => void) | null {
  const requestedRoot = requireStorageOutputRoot(outputRoot)
  const job = storageJobs.get(id)
  if (!job || !matchesStorageJobRoot(job, requestedRoot)) return null
  job.listeners.add(cb)
  return () => {
    job.listeners.delete(cb)
  }
}

function readJsonlTail(filePath: string, maxRecords: number): PreviewRecord[] {
  if (!fs.existsSync(filePath)) return []
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size <= 0) return []
  const maxBytes = 4 * 1024 * 1024
  const bytesToRead = Math.min(stat.size, maxBytes)
  const start = Math.max(0, stat.size - bytesToRead)
  const buffer = Buffer.alloc(bytesToRead)
  const handle = fs.openSync(filePath, 'r')
  try {
    fs.readSync(handle, buffer, 0, bytesToRead, start)
  } finally {
    fs.closeSync(handle)
  }
  const lines = buffer.toString('utf8').split(/\r?\n/)
  if (start > 0) lines.shift()
  const records: PreviewRecord[] = []
  for (let index = lines.length - 1; index >= 0 && records.length < maxRecords; index -= 1) {
    const line = String(lines[index] ?? '').trim()
    if (!line) continue
    try {
      const record = JSON.parse(line) as PreviewRecord
      if (record && typeof record === 'object') records.push(record)
    } catch {}
  }
  return records
}

function previewToken(record: PreviewRecord): string {
  const parts = [
    record.md5,
    record.picid,
    record.specid,
    record.seriesid,
    record.saved_path,
    record.preview_path,
    record.url,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  return parts.length ? createHash('sha1').update(parts.join('\0')).digest('hex') : ''
}

function previewRecordCacheKey(root: string, kind: CrawlPreviewKind, token: string): string {
  return `${path.resolve(root).toLowerCase()}\0${kind}\0${token}`
}

function cachePreviewRecord(
  root: string,
  kind: CrawlPreviewKind,
  token: string,
  record: PreviewRecord,
) {
  const key = previewRecordCacheKey(root, kind, token)
  previewRecordCache.delete(key)
  previewRecordCache.set(key, record)
  while (previewRecordCache.size > PREVIEW_RECORD_CACHE_LIMIT) {
    const oldestKey = previewRecordCache.keys().next().value
    if (oldestKey === undefined) break
    previewRecordCache.delete(oldestKey)
  }
}

function previewSourceKey(root: string, kind: CrawlPreviewKind, record: PreviewRecord): string | null {
  if (kind === 'accepted') {
    const localPath = resolveAcceptedPreviewPath(root, record)
    return localPath && fs.existsSync(localPath) && isPathInside(root, localPath)
      ? `local:${path.resolve(localPath).toLowerCase()}`
      : null
  }

  const localPath = resolveRejectedPreviewPath(root, record)
  if (localPath) return `local:${path.resolve(localPath).toLowerCase()}`

  const remoteUrl = allowedRemotePreviewUrl(record.url)
  return remoteUrl ? `remote:${remoteUrl}` : null
}

function findPreviewRecord(root: string, kind: CrawlPreviewKind, token: string): PreviewRecord | null {
  const cacheKey = previewRecordCacheKey(root, kind, token)
  const cached = previewRecordCache.get(cacheKey)
  if (cached) {
    previewRecordCache.delete(cacheKey)
    previewRecordCache.set(cacheKey, cached)
    return cached
  }
  const fileName = kind === 'accepted' ? 'metadata.jsonl' : 'rejected.jsonl'
  const records = readJsonlTail(path.resolve(root, fileName), PREVIEW_RECORD_LOOKBACK)
  const record = records.find((candidate) => previewToken(candidate) === token) ?? null
  if (record) cachePreviewRecord(root, kind, token, record)
  return record
}

function resolveAcceptedImagePath(root: string, record: PreviewRecord): string | null {
  const savedPath = String(record.saved_path ?? '').trim()
  if (!savedPath) return null
  if (path.isAbsolute(savedPath)) return path.resolve(savedPath)
  const projectRelative = path.resolve(resolveProjectRoot(), savedPath)
  if (fs.existsSync(projectRelative)) return projectRelative
  return path.resolve(root, savedPath)
}

function resolvePipelineArtifactPath(
  root: string,
  record: PreviewRecord,
  keys: Array<'decision' | 'birefnet'>,
): string | null {
  const artifacts = record.pipeline_artifacts
  if (!artifacts || typeof artifacts !== 'object') return null
  const stageRoot = path.resolve(root, '_pipeline_stages')
  for (const key of keys) {
    const artifactPath = String((artifacts as Record<string, unknown>)[key] ?? '').trim()
    if (!artifactPath) continue
    const resolved = path.isAbsolute(artifactPath)
      ? path.resolve(artifactPath)
      : path.resolve(root, artifactPath)
    if (isPathInside(stageRoot, resolved) && fs.existsSync(resolved)) return resolved
  }
  return null
}

function resolveAcceptedPreviewPath(root: string, record: PreviewRecord): string | null {
  return resolvePipelineArtifactPath(root, record, ['decision', 'birefnet'])
    ?? resolveAcceptedImagePath(root, record)
}

function resolveRejectedPreviewPath(root: string, record: PreviewRecord): string | null {
  const artifactPath = resolvePipelineArtifactPath(root, record, ['decision', 'birefnet'])
  if (artifactPath) return artifactPath
  const previewPath = String(record.preview_path ?? '').trim()
  if (!previewPath) return null
  const resolved = path.isAbsolute(previewPath) ? path.resolve(previewPath) : path.resolve(root, previewPath)
  const reviewRoot = path.resolve(root, '_review', 'rejected')
  return isPathInside(reviewRoot, resolved) && fs.existsSync(resolved) ? resolved : null
}

function allowedRemotePreviewUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''))
    const host = url.hostname.toLowerCase()
    const allowed = host === 'autoimg.cn' || host.endsWith('.autoimg.cn') || host === 'autohome.com.cn' || host.endsWith('.autohome.com.cn')
    return ['http:', 'https:'].includes(url.protocol) && allowed ? url.toString() : null
  } catch {
    return null
  }
}

export function getCrawlPreviews(
  outputRoot: unknown,
  kind: CrawlPreviewKind,
  requestedLimit: unknown,
): { items: CrawlPreviewItem[] } {
  const root = resolvePreviewRoot(outputRoot)
  const limit = Math.max(1, Math.min(20, Number(requestedLimit) || 8))
  const fileName = kind === 'accepted' ? 'metadata.jsonl' : 'rejected.jsonl'
  const records = readJsonlTail(path.resolve(root, fileName), PREVIEW_RECORD_LOOKBACK)
  const items: CrawlPreviewItem[] = []
  const seenSources = new Set<string>()
  for (const record of records) {
    if (items.length >= limit) break
    const token = previewToken(record)
    if (!token) continue
    const sourceKey = previewSourceKey(root, kind, record)
    if (!sourceKey || seenSources.has(sourceKey)) continue
    seenSources.add(sourceKey)
    cachePreviewRecord(root, kind, token, record)
    const quality = (record.quality && typeof record.quality === 'object' ? record.quality : {}) as Record<string, any>
    const viewData = (quality.view && typeof quality.view === 'object' ? quality.view : {}) as Record<string, any>
    const canonicalView = (record.view && typeof record.view === 'object' ? record.view : {}) as Record<string, any>
    const cleanData = (quality.clean && typeof quality.clean === 'object' ? quality.clean : {}) as Record<string, any>
    const query = new URLSearchParams({ kind, out: root, token })
    items.push({
      id: token,
      kind,
      imageUrl: `/api/crawl/previews/image?${query.toString()}`,
      view: String(canonicalView.label ?? record.view ?? viewData.label ?? record.view_raw ?? '').trim() || undefined,
      reason: kind === 'rejected' ? String(record.reject_reason ?? quality.reason ?? '').trim() || undefined : undefined,
      confidence: Number(cleanData.confidence ?? record.view_confidence ?? canonicalView.confidence ?? viewData.confidence ?? NaN),
      specName: String(record.specname ?? '').trim() || undefined,
      picId: Number.isFinite(Number(record.picid)) ? Number(record.picid) : undefined,
    })
  }
  for (const item of items) {
    if (!Number.isFinite(item.confidence)) delete item.confidence
  }
  return { items }
}

export function getCrawlPreviewSource(
  outputRoot: unknown,
  kind: CrawlPreviewKind,
  tokenValue: unknown,
): { localPath?: string; remoteUrl?: string } | null {
  const root = resolvePreviewRoot(outputRoot)
  const token = String(tokenValue ?? '').trim()
  if (!token) return null
  const record = findPreviewRecord(root, kind, token)
  if (!record) return null
  if (kind === 'accepted') {
    const localPath = resolveAcceptedPreviewPath(root, record)
    if (!localPath || !fs.existsSync(localPath) || !isPathInside(root, localPath)) return null
    return { localPath }
  }
  const localPath = resolveRejectedPreviewPath(root, record)
  if (localPath) return { localPath }
  const remoteUrl = allowedRemotePreviewUrl(record.url)
  return remoteUrl ? { remoteUrl } : null
}

export function listJobs(): CrawlJobSummary[] {
  return Array.from(jobs.values())
    .map((j) => ({
      id: j.id,
      status: j.status,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      pid: j.pid,
      exitCode: j.exitCode,
      signal: j.signal,
      args: j.args,
      metrics: { ...j.metrics },
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function getJob(id: string): CrawlJobSummary | null {
  const j = jobs.get(id)
  if (!j) return null
  return {
    id: j.id,
    status: j.status,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    pid: j.pid,
    exitCode: j.exitCode,
    signal: j.signal,
    args: j.args,
    metrics: { ...j.metrics },
  }
}

export function getPipelineModelStatus(): PipelineModelStatus {
  const projectRoot = resolveProjectRoot()
  const datasetRoot = resolveDatasetRoot()
  const subjectPath = path.resolve(projectRoot, 'models', 'birefnet', 'epoch_120.pth')
  const canonicalViewPath = path.resolve(projectRoot, 'models', 'view-cls', 'yolo11m-cls-for-car-view-train7.pt')
  const legacyViewPath = path.resolve(projectRoot, 'models', 'yolo11m-cls-for-car-view-train7.pt')
  const viewPath = fs.existsSync(canonicalViewPath) || !fs.existsSync(legacyViewPath) ? canonicalViewPath : legacyViewPath
  const cleanDir = path.resolve(projectRoot, 'models', 'view-clean')
  const cleanModels = fs.existsSync(cleanDir)
    ? fs
        .readdirSync(cleanDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pt'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))
    : []
  const stages: PipelineModelStatus['stages'] = [
    { id: 'subject', label: '主体扣取', ready: fs.existsSync(subjectPath), path: subjectPath },
    { id: 'view', label: '角度分类', ready: fs.existsSync(viewPath), path: viewPath },
    { id: 'clean', label: '分角度清洗', ready: cleanModels.length > 0, path: cleanDir, models: cleanModels },
  ]
  return { ready: stages.every((stage) => stage.ready), projectRoot, datasetRoot, stages }
}

export function getJobLogTail(id: string): { lines: string[]; logPath?: string } | null {
  const j = jobs.get(id)
  if (!j) return null
  return { lines: j.lines.slice(), logPath: j.logPath }
}

export function subscribeJob(id: string, cb: Listener): (() => void) | null {
  const j = jobs.get(id)
  if (!j) return null
  j.listeners.add(cb)
  return () => {
    j.listeners.delete(cb)
  }
}

export function stopJob(id: string): CrawlJobSummary | null {
  const j = jobs.get(id)
  if (!j) return null
  if (j.status !== 'running' || !j.proc) return getJob(id)
  try {
    j.proc.kill('SIGTERM')
    j.status = 'stopped'
    j.endedAt = Date.now()
    pushLine(j, formatLine('stderr', 'SIGTERM requested'))
  } catch {
    j.status = 'failed'
    j.endedAt = Date.now()
  }
  return getJob(id)
}

export function startJob(input: Record<string, unknown>): CrawlJobSummary {
  const id = randomUUID()
  const startedAt = Date.now()

  const logDir = getLogDir()
  ensureDir(logDir)
  const logPath = path.resolve(logDir, `${id}.log`)

  const args = buildArgs(input)

  const job: CrawlJob = {
    id,
    status: 'running',
    startedAt,
    args,
    logPath,
    lines: [],
    listeners: new Set(),
    metrics: { accepted: 0, rejected: 0, errors: 0 },
  }
  jobs.set(id, job)

  const python = resolvePythonBin()
  const cwd = resolveProjectRoot()

  const proc = spawn(python, args, {
    cwd,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: [cwd, String(process.env.PYTHONPATH ?? '')].filter(Boolean).join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.proc = proc
  job.pid = proc.pid

  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  let logWritable = true
  let finalized = false

  function safeWriteLine(line: string) {
    if (!logWritable) return
    if (logStream.destroyed || logStream.writableEnded) {
      logWritable = false
      return
    }
    try {
      logStream.write(`${line}\n`)
    } catch {
      logWritable = false
    }
  }

  function emitLine(src: 'stdout' | 'stderr', line: string) {
    const clean = String(line ?? '').replace(/\s+$/g, '')
    if (!clean) return
    const s = formatLine(src, clean)
    safeWriteLine(s)
    pushLine(job, s)
  }

  emitLine('stderr', `spawn: ${python} ${args.join(' ')}`)
  emitLine('stderr', `cwd: ${cwd}`)

  let outBuf = ''
  let errBuf = ''

  function handleChunk(src: 'stdout' | 'stderr', chunk: Buffer) {
    const text = String(chunk ?? '')
    const normalized = text.replace(/\r/g, '\n')
    if (src === 'stdout') outBuf += normalized
    else errBuf += normalized

    const buf = src === 'stdout' ? outBuf : errBuf
    const parts = buf.split('\n')
    const rest = parts.pop() ?? ''
    for (const p of parts) emitLine(src, p)
    if (src === 'stdout') outBuf = rest
    else errBuf = rest
  }

  const onStdoutData = (chunk: Buffer) => {
    handleChunk('stdout', chunk)
  }
  const onStderrData = (chunk: Buffer) => {
    handleChunk('stderr', chunk)
  }
  proc.stdout.on('data', onStdoutData)
  proc.stderr.on('data', onStderrData)

  function closeReadersAndFlush() {
    proc.stdout.off('data', onStdoutData)
    proc.stderr.off('data', onStderrData)
    if (outBuf) emitLine('stdout', outBuf)
    if (errBuf) emitLine('stderr', errBuf)
    outBuf = ''
    errBuf = ''
  }

  function finalize(src: 'stdout' | 'stderr', line: string) {
    if (finalized) return
    finalized = true
    closeReadersAndFlush()
    emitLine(src, line)
    try {
      logStream.end()
    } catch {}
  }

  logStream.on('error', (e) => {
    logWritable = false
    const s = formatLine(
      'stderr',
      `log file error: ${String((e as { message?: unknown } | null | undefined)?.message ?? e)}`,
    )
    pushLine(job, s)
  })

  proc.on('close', (code, signal) => {
    job.exitCode = code
    job.signal = signal
    job.endedAt = Date.now()
    job.status = code === 0 ? 'exited' : job.status === 'stopped' ? 'stopped' : 'failed'
    finalize('stderr', `process closed code=${String(code)} signal=${String(signal ?? '')}`)
  })

  proc.on('error', (e) => {
    job.status = 'failed'
    job.endedAt = Date.now()
    finalize('stderr', `spawn error: ${String((e as { message?: unknown } | null | undefined)?.message ?? e)}`)
  })

  return getJob(id) as CrawlJobSummary
}
