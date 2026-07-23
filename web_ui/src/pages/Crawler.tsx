import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Database,
  ImageIcon,
  Play,
  RefreshCw,
  ScanLine,
  Square,
  Terminal,
  X,
  XCircle,
} from 'lucide-react'
import {
  getCrawlPreviews,
  getPipelineModelStatus,
  listCrawlJobs,
  startCrawlJob,
  stopCrawlJob,
  type CrawlJob,
  type CrawlPreviewItem,
  type CrawlPreviewKind,
  type PipelineModelStatus,
  type StartCrawlJobInput,
} from '@/lib/api'
import { StoragePanel } from '@/components/crawler/StoragePanel'

type LogEvent = { type: 'init'; lines: string[] } | { type: 'log'; line: string }

const fieldClass =
  'h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20'
const labelClass = 'mb-1.5 block text-xs font-medium text-slate-300'
const transparencyGridStyle: CSSProperties = {
  backgroundColor: '#f8fafc',
  backgroundImage:
    'linear-gradient(45deg, #cbd5e1 25%, transparent 25%), linear-gradient(-45deg, #cbd5e1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cbd5e1 75%), linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
  backgroundSize: '16px 16px',
}

function clampInt(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback
}

function clampFloat(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : fallback
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '-'
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000))
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function statusInfo(status?: string): { text: string; className: string } {
  if (status === 'running') return { text: '运行中', className: 'border-emerald-500/40 text-emerald-300' }
  if (status === 'exited') return { text: '已完成', className: 'border-cyan-500/40 text-cyan-300' }
  if (status === 'stopped') return { text: '已停止', className: 'border-amber-500/40 text-amber-300' }
  if (status === 'failed') return { text: '失败', className: 'border-rose-500/40 text-rose-300' }
  return { text: '空闲', className: 'border-slate-600 text-slate-300' }
}

function reasonLabel(reason?: string): string {
  const labels: Record<string, string> = {
    subject_extraction_failed: '主体扣取失败',
    invalid_subject_mask: '主体掩码异常',
    view_classification_failed: '角度分类失败',
    view_low_confidence: '角度置信度不足',
    clean_model_missing: '缺少角度清洗模型',
    clean_classification_failed: '清洗分类失败',
    clean_low_confidence: '清洗置信度不足',
    clean_rejected: '清洗不合格',
    view_filtered: '角度被过滤',
    view_quota_reached: '角度配额已满',
    image_decode_failed: '原图解码失败',
    min_size_rejected: '尺寸不符合要求',
  }
  return labels[String(reason ?? '')] ?? String(reason ?? '未知原因')
}

function cacheBustUrl(url: string, version: number): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${version}`
}

export default function Crawler() {
  const [workspaceTab, setWorkspaceTab] = useState<'monitor' | 'storage'>('monitor')
  const [form, setForm] = useState<StartCrawlJobInput>({
    out: './dataset_png',
    category: 1,
    minSize: 721,
    minYear: 2020,
    maxYear: 2026,
    viewScheme: 'front_back_front45_back45',
    onlyView: 'front',
    viewBins: 'raw',
    maxPerView: 1,
    requiredViews: 'front',
    viewMinConf: 0.5,
    cleanMinConf: 0.5,
    maskThreshold: 0.5,
    birefnetSize: 0,
    qualityGate: true,
    keepStageImages: true,
    device: 'auto',
    sleep: 0.2,
    timeout: 20,
    retries: 3,
    prefer: 'nowebppic',
  })
  const [pipeline, setPipeline] = useState<PipelineModelStatus | null>(null)
  const [jobs, setJobs] = useState<CrawlJob[]>([])
  const [activeJob, setActiveJob] = useState<CrawlJob | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [now, setNow] = useState(Date.now())
  const [previewKind, setPreviewKind] = useState<CrawlPreviewKind>('accepted')
  const [previews, setPreviews] = useState<CrawlPreviewItem[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewVersion, setPreviewVersion] = useState(Date.now())
  const [selectedPreview, setSelectedPreview] = useState<CrawlPreviewItem | null>(null)
  const logBoxRef = useRef<HTMLDivElement | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const connectedJobIdRef = useRef<string | null>(null)
  const previewRequestRef = useRef(0)

  const activeStatus = useMemo(() => statusInfo(activeJob?.status), [activeJob?.status])
  const metrics = activeJob?.metrics ?? { accepted: 0, rejected: 0, errors: 0 }

  function syncJobs() {
    listCrawlJobs()
      .then((response) => {
        setJobs(response.items)
        setActiveJob((current) => response.items.find((job) => job.id === current?.id) ?? current)
      })
      .catch((reason) => setError(String(reason?.message ?? reason)))
  }

  function syncPipeline() {
    getPipelineModelStatus()
      .then((status) => {
        setPipeline(status)
        setForm((current) =>
          current.out === './dataset_png' ? { ...current, out: status.datasetRoot } : current,
        )
      })
      .catch((reason) => setError(String(reason?.message ?? reason)))
  }

  function syncPreviews(kind: CrawlPreviewKind = previewKind, options: { clear?: boolean } = {}) {
    const outputRoot = String(form.out ?? '').trim()
    const requestId = previewRequestRef.current + 1
    previewRequestRef.current = requestId
    if (!outputRoot) {
      setPreviews([])
      return
    }
    if (options.clear) setPreviews([])
    setPreviewLoading(true)
    getCrawlPreviews(outputRoot, kind, 8)
      .then((response) => {
        if (requestId !== previewRequestRef.current) return
        setPreviews(response.items)
        setPreviewVersion(Date.now())
      })
      .catch(() => {
        if (requestId === previewRequestRef.current) setPreviews([])
      })
      .finally(() => {
        if (requestId === previewRequestRef.current) setPreviewLoading(false)
      })
  }

  function changePreviewKind(kind: CrawlPreviewKind) {
    const changed = kind !== previewKind
    if (changed) {
      setPreviews([])
      setSelectedPreview(null)
    }
    setPreviewKind(kind)
    syncPreviews(kind, { clear: changed })
  }

  useEffect(() => {
    syncJobs()
    syncPipeline()
    const interval = window.setInterval(() => {
      syncJobs()
      setNow(Date.now())
    }, 2000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (autoScroll && logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
  }, [lines, autoScroll])

  useEffect(() => {
    syncPreviews(previewKind)
    const interval = window.setInterval(() => syncPreviews(previewKind), 4000)
    return () => window.clearInterval(interval)
  }, [form.out, previewKind])

  useEffect(() => {
    if (!selectedPreview) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedPreview(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedPreview])

  function disconnectLogStream() {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    connectedJobIdRef.current = null
  }

  useEffect(
    () => () => {
      disconnectLogStream()
    },
    [],
  )

  function connect(job: CrawlJob) {
    disconnectLogStream()
    setLines([])
    const source = new EventSource(`/api/crawl/jobs/${encodeURIComponent(job.id)}/stream`)
    eventSourceRef.current = source
    connectedJobIdRef.current = job.id

    const onMessage = (type: LogEvent['type']) => (event: MessageEvent<string>) => {
      let payload: any = null
      try {
        payload = JSON.parse(String(event.data ?? ''))
      } catch {
        return
      }
      if (type === 'init') {
        setLines(Array.isArray(payload?.lines) ? payload.lines.map(String) : [])
      } else if (payload?.line) {
        setLines((previous) => previous.slice(-4999).concat(String(payload.line)))
      }
    }
    source.addEventListener('init', onMessage('init'))
    source.addEventListener('log', onMessage('log'))
    source.onerror = () => {
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null
        connectedJobIdRef.current = null
      }
      source.close()
    }
  }

  useEffect(() => {
    if (workspaceTab !== 'monitor') {
      disconnectLogStream()
      return
    }
    if (!activeJob) return
    if (connectedJobIdRef.current === activeJob.id) return
    connect(activeJob)
  }, [activeJob, workspaceTab])

  async function start() {
    if (starting || !pipeline?.ready) return
    setStarting(true)
    setError('')
    try {
      const payload: StartCrawlJobInput = {
        ...form,
        qualityGate: true,
        category: clampInt(form.category, 1),
        minSize: clampInt(form.minSize, 0),
        minYear: clampInt(form.minYear, 0),
        maxYear: clampInt(form.maxYear, 0),
        maxPerView: clampInt(form.maxPerView, 0),
        maxSeries: clampInt(form.maxSeries, 0),
        maxPerSeries: clampInt(form.maxPerSeries, 0),
        maxTotal: clampInt(form.maxTotal, 0),
        retries: clampInt(form.retries, 3),
        sleep: clampFloat(form.sleep, 0.2),
        timeout: clampFloat(form.timeout, 20),
        viewMinConf: clampFloat(form.viewMinConf, 0.5),
        cleanMinConf: clampFloat(form.cleanMinConf, 0.5),
        maskThreshold: clampFloat(form.maskThreshold, 0.5),
        birefnetSize: clampInt(form.birefnetSize, 0),
      }
      const job = await startCrawlJob(payload)
      setActiveJob(job)
      syncJobs()
    } catch (reason) {
      setError(String((reason as any)?.message ?? reason))
    } finally {
      setStarting(false)
    }
  }

  async function stop() {
    if (!activeJob) return
    try {
      setActiveJob(await stopCrawlJob(activeJob.id))
      syncJobs()
    } catch (reason) {
      setError(String((reason as any)?.message ?? reason))
    }
  }

  function copyCommand() {
    if (!activeJob) return
    const command = `python ${activeJob.args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`
    navigator.clipboard.writeText(command).catch(() => undefined)
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md border border-cyan-700/60 bg-cyan-950/40">
              <ScanLine className="h-5 w-5 text-cyan-300" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-semibold">图片采集与清洗</h1>
              <p className="text-xs text-slate-400">采集流水线控制台</p>
            </div>
          </div>
          <Link
            to="/"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            图片库
          </Link>
        </div>
      </header>

      <section className="border-b border-slate-800 bg-slate-900/30">
        <div className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">质量门禁</h2>
            <button
              type="button"
              onClick={syncPipeline}
              className="grid h-10 w-10 place-items-center rounded-md border border-slate-700 transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
              aria-label="刷新模型状态"
              title="刷新模型状态"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            {(pipeline?.stages ?? []).map((stage, index) => (
              <div key={stage.id} className="flex min-w-0 items-center gap-3 rounded-md border border-slate-800 bg-slate-950 p-3">
                <span className="font-mono text-xs text-slate-500">{String(index + 1).padStart(2, '0')}</span>
                {stage.ready ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <XCircle className="h-5 w-5 shrink-0 text-rose-400" aria-hidden="true" />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium">{stage.label}</div>
                  <div className="truncate text-xs text-slate-500" title={stage.models?.join(', ') || stage.path}>
                    {stage.models?.join(', ') || stage.path}
                  </div>
                </div>
              </div>
            ))}
            {!pipeline ? <div className="text-sm text-slate-400">正在读取模型状态...</div> : null}
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1500px] gap-0 lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="border-b border-slate-800 px-4 py-5 sm:px-6 lg:border-b-0 lg:border-r">
          <h2 className="mb-4 text-sm font-semibold">任务配置</h2>
          <div className="space-y-5">
            <fieldset className="space-y-3">
              <legend className="mb-2 text-xs font-semibold text-slate-500">采集范围</legend>
              <label>
                <span className={labelClass}>输出目录</span>
                <input className={fieldClass} value={form.out} onChange={(e) => setForm({ ...form, out: e.target.value })} />
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['最小年份', 'minYear'],
                  ['最大年份', 'maxYear'],
                  ['最小尺寸', 'minSize'],
                ].map(([label, key]) => (
                  <label key={key}>
                    <span className={labelClass}>{label}</span>
                    <input
                      className={fieldClass}
                      inputMode="numeric"
                      value={String(form[key as keyof StartCrawlJobInput] ?? '')}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <label>
                <span className={labelClass}>保留角度</span>
                <input className={fieldClass} value={form.onlyView} onChange={(e) => setForm({ ...form, onlyView: e.target.value })} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className={labelClass}>每角度上限</span>
                  <input
                    className={fieldClass}
                    inputMode="numeric"
                    value={String(form.maxPerView ?? '')}
                    onChange={(e) => setForm({ ...form, maxPerView: e.target.value as any })}
                  />
                </label>
                <label>
                  <span className={labelClass}>每车系上限</span>
                  <input
                    className={fieldClass}
                    inputMode="numeric"
                    value={String(form.maxPerSeries ?? '')}
                    onChange={(e) => setForm({ ...form, maxPerSeries: e.target.value as any })}
                    placeholder="0"
                  />
                </label>
              </div>
            </fieldset>

            <fieldset className="space-y-3 border-t border-slate-800 pt-4">
              <legend className="mb-2 text-xs font-semibold text-slate-500">模型阈值</legend>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['主体', 'maskThreshold'],
                  ['角度', 'viewMinConf'],
                  ['清洗', 'cleanMinConf'],
                ].map(([label, key]) => (
                  <label key={key}>
                    <span className={labelClass}>{label}</span>
                    <input
                      className={fieldClass}
                      inputMode="decimal"
                      value={String(form[key as keyof StartCrawlJobInput] ?? '')}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <label>
                <span className={labelClass}>推理设备</span>
                <select className={fieldClass} value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })}>
                  <option value="auto">自动</option>
                  <option value="cpu">CPU</option>
                  {Array.from({ length: 8 }, (_, index) => (
                    <option key={index} value={`cuda:${index}`}>
                      CUDA {index}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelClass}>BiRefNet 输入尺寸</span>
                <input
                  className={fieldClass}
                  inputMode="numeric"
                  value={String(form.birefnetSize ?? '')}
                  onChange={(e) => setForm({ ...form, birefnetSize: e.target.value as any })}
                  placeholder="0"
                />
              </label>
            </fieldset>

            <fieldset className="space-y-3 border-t border-slate-800 pt-4">
              <legend className="mb-2 text-xs font-semibold text-slate-500">任务限制</legend>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['车系数', 'maxSeries'],
                  ['总图片', 'maxTotal'],
                  ['重试', 'retries'],
                ].map(([label, key]) => (
                  <label key={key}>
                    <span className={labelClass}>{label}</span>
                    <input
                      className={fieldClass}
                      inputMode="numeric"
                      value={String(form[key as keyof StartCrawlJobInput] ?? '')}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      placeholder="0"
                    />
                  </label>
                ))}
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:bg-slate-900">
                <input
                  type="checkbox"
                  checked={form.keepStageImages !== false}
                  onChange={(event) => setForm({ ...form, keepStageImages: event.target.checked })}
                  className="h-4 w-4 accent-cyan-500"
                />
                <span>保留流水线阶段图片</span>
              </label>
            </fieldset>

            <div className="grid grid-cols-[1fr_auto] gap-2 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => void start()}
                disabled={starting || !pipeline?.ready || !String(form.out ?? '').trim()}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-cyan-600 px-4 text-sm font-semibold text-white transition hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                {starting ? '启动中' : '启动流水线'}
              </button>
              <button
                type="button"
                onClick={() => void stop()}
                disabled={activeJob?.status !== 'running'}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-slate-700 px-4 text-sm transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Square className="h-4 w-4" aria-hidden="true" />
                停止
              </button>
            </div>
            {error ? <div role="alert" className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</div> : null}
          </div>
        </aside>

        <section className="min-w-0 px-4 py-5 sm:px-6">
          <div className="mb-4 flex items-center gap-2 border-b border-slate-800 pb-3">
            <button
              type="button"
              onClick={() => setWorkspaceTab('monitor')}
              className={`h-9 rounded-md px-3 text-sm transition ${
                workspaceTab === 'monitor' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              运行监控
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceTab('storage')}
              className={`h-9 rounded-md px-3 text-sm transition ${
                workspaceTab === 'storage' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              目录管理
            </button>
          </div>

          {workspaceTab === 'storage' ? (
            <StoragePanel
              outputRoot={String(form.out ?? '').trim()}
              onMutated={() => {
                syncPreviews(previewKind, { clear: true })
                syncJobs()
              }}
            />
          ) : (
            <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-cyan-300" aria-hidden="true" />
              <h2 className="text-sm font-semibold">运行状态</h2>
              <span className={`rounded-full border px-2.5 py-1 text-xs ${activeStatus.className}`}>{activeStatus.text}</span>
            </div>
            <button
              type="button"
              onClick={copyCommand}
              disabled={!activeJob}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 disabled:opacity-40"
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              复制命令
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <button
              type="button"
              aria-pressed={previewKind === 'accepted'}
              onClick={() => {
                changePreviewKind('accepted')
              }}
              className={`flex items-center justify-between rounded-md border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-cyan-500/40 ${
                previewKind === 'accepted'
                  ? 'border-emerald-500/60 bg-emerald-950/20'
                  : 'border-slate-800 bg-slate-900/30 hover:border-slate-600'
              }`}
            >
              <span><span className="block text-xs text-slate-400">已落库</span><span className="mt-1 block font-mono text-2xl font-semibold tabular-nums">{metrics.accepted}</span></span>
              <Database className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={previewKind === 'rejected'}
              onClick={() => {
                changePreviewKind('rejected')
              }}
              className={`flex items-center justify-between rounded-md border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-cyan-500/40 ${
                previewKind === 'rejected'
                  ? 'border-amber-500/60 bg-amber-950/20'
                  : 'border-slate-800 bg-slate-900/30 hover:border-slate-600'
              }`}
            >
              <span><span className="block text-xs text-slate-400">已拒绝</span><span className="mt-1 block font-mono text-2xl font-semibold tabular-nums">{metrics.rejected}</span></span>
              <XCircle className="h-5 w-5 text-amber-400" aria-hidden="true" />
            </button>
            <div className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900/30 p-4">
              <div><div className="text-xs text-slate-400">错误</div><div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{metrics.errors}</div></div>
              <Activity className="h-5 w-5 text-rose-400" aria-hidden="true" />
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-md border border-slate-800">
            <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
              <div className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-slate-400" aria-hidden="true" />
                <span className="text-sm font-medium">最近{previewKind === 'accepted' ? '落库' : '拒绝'}</span>
              </div>
              <div className="flex items-center gap-1 rounded-md border border-slate-700 p-1">
                <button
                  type="button"
                  onClick={() => changePreviewKind('accepted')}
                  className={`h-8 rounded px-3 text-xs transition ${previewKind === 'accepted' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  已落库
                </button>
                <button
                  type="button"
                  onClick={() => changePreviewKind('rejected')}
                  className={`h-8 rounded px-3 text-xs transition ${previewKind === 'rejected' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  已拒绝
                </button>
                <button
                  type="button"
                  onClick={() => syncPreviews(previewKind, { clear: true })}
                  className="grid h-8 w-8 place-items-center rounded text-slate-400 transition hover:bg-slate-800 hover:text-white"
                  aria-label="刷新预览"
                  title="刷新预览"
                >
                  <RefreshCw className={`h-4 w-4 ${previewLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                </button>
              </div>
            </div>
            {previews.length ? (
              <div className="grid grid-cols-2 gap-px bg-slate-800 sm:grid-cols-4 2xl:grid-cols-8">
                {previews.map((item) => (
                  <button
                    type="button"
                    key={`${item.kind}-${item.id}`}
                    onClick={() => setSelectedPreview(item)}
                    className="group min-w-0 bg-slate-950 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500"
                  >
                    <div className="aspect-[4/3] overflow-hidden" style={transparencyGridStyle}>
                      <img
                        src={cacheBustUrl(item.imageUrl, previewVersion)}
                        alt={`${item.kind === 'accepted' ? '落库' : '拒绝'}图片 ${item.picId ?? item.id}`}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-contain transition duration-200 group-hover:scale-[1.02]"
                      />
                    </div>
                    <div className="min-w-0 p-2">
                      <div className="truncate text-xs font-medium text-slate-200">{item.view || '角度未知'}</div>
                      <div className="mt-1 truncate text-[11px] text-slate-500" title={item.reason ? reasonLabel(item.reason) : item.specName}>
                        {item.kind === 'rejected' ? reasonLabel(item.reason) : item.specName || `图片 ${item.picId ?? ''}`}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid h-32 place-items-center text-sm text-slate-500">
                {previewLoading ? '正在读取预览...' : `暂无${previewKind === 'accepted' ? '落库' : '拒绝'}记录`}
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
            <div className="min-w-0 rounded-md border border-slate-800">
              <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-400">最近任务</div>
              <div className="max-h-56 overflow-auto p-2">
                {jobs.length ? (
                  jobs.slice(0, 8).map((job) => {
                    const status = statusInfo(job.status)
                    return (
                      <button
                        type="button"
                        key={job.id}
                        onClick={() => {
                          setActiveJob(job)
                          connect(job)
                        }}
                        className="mb-1 flex h-10 w-full items-center justify-between gap-2 rounded-md px-2 text-left transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                      >
                        <span className="truncate font-mono text-xs">{job.id.slice(0, 8)}</span>
                        <span className={`text-xs ${status.className.split(' ').at(-1)}`}>{status.text}</span>
                      </button>
                    )
                  })
                ) : (
                  <div className="p-3 text-sm text-slate-500">暂无任务</div>
                )}
              </div>
              <dl className="border-t border-slate-800 p-3 text-xs">
                <div className="flex justify-between gap-2 py-1"><dt className="text-slate-500">开始</dt><dd>{formatTime(activeJob?.startedAt)}</dd></div>
                <div className="flex justify-between gap-2 py-1"><dt className="text-slate-500">耗时</dt><dd className="font-mono">{activeJob ? formatDuration((activeJob.endedAt ?? now) - activeJob.startedAt) : '-'}</dd></div>
                <div className="flex justify-between gap-2 py-1"><dt className="text-slate-500">PID</dt><dd className="font-mono">{activeJob?.pid ?? '-'}</dd></div>
              </dl>
            </div>

            <div className="min-w-0 overflow-hidden rounded-md border border-slate-800 bg-black">
              <div className="flex h-11 items-center justify-between border-b border-slate-800 px-3">
                <div className="flex items-center gap-2 text-sm"><Terminal className="h-4 w-4 text-slate-400" aria-hidden="true" />任务日志</div>
                <label className="flex h-9 items-center gap-2 text-xs text-slate-400">
                  <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-cyan-500" />
                  自动滚动
                </label>
              </div>
              <div ref={logBoxRef} className="h-[500px] overflow-auto p-3 font-mono text-xs leading-5 text-slate-300">
                {lines.length ? lines.map((line, index) => (
                  <div key={`${index}-${line.slice(0, 20)}`} className={`whitespace-pre-wrap break-words ${line.includes('ERROR') || line.includes('Traceback') ? 'text-rose-300' : ''}`}>
                    {line}
                  </div>
                )) : <div className="grid h-full place-items-center text-slate-600">暂无日志</div>}
              </div>
            </div>
          </div>
            </>
          )}
        </section>
      </div>

      {selectedPreview ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedPreview(null)
          }}
        >
          <div className="w-full max-w-5xl overflow-hidden rounded-md border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-800 px-4 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {selectedPreview.kind === 'accepted' ? '已落库' : '已拒绝'} · {selectedPreview.view || '角度未知'}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {selectedPreview.kind === 'rejected'
                    ? reasonLabel(selectedPreview.reason)
                    : selectedPreview.specName || `图片 ${selectedPreview.picId ?? selectedPreview.id}`}
                  {selectedPreview.confidence !== undefined ? ` · ${(selectedPreview.confidence * 100).toFixed(1)}%` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPreview(null)}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-slate-700 text-slate-300 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                aria-label="关闭预览"
                title="关闭预览"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div
              className="grid max-h-[calc(100dvh-8rem)] min-h-64 place-items-center overflow-auto p-3"
              style={transparencyGridStyle}
            >
              <img
                src={cacheBustUrl(selectedPreview.imageUrl, previewVersion)}
                alt={`${selectedPreview.kind === 'accepted' ? '落库' : '拒绝'}图片大图`}
                referrerPolicy="no-referrer"
                className="max-h-[calc(100dvh-11rem)] max-w-full object-contain"
              />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
