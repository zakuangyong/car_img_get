import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from 'lucide-react'
import type { StorageJobListItem, StorageJobStatus } from '@/lib/api'
import { storageActionLabel, storageTargetLabel } from '@/lib/crawler-storage'

type LogEvent = { type: 'init'; lines: string[]; status: StorageJobStatus } | { type: 'log'; line: string } | { type: 'done'; lines: string[]; status: StorageJobStatus }

type Props = {
  jobs: StorageJobListItem[]
  outputRoot: string
  selectedJobId: string | null
  onSelectJob: (jobId: string) => void
}

function statusInfo(status: StorageJobStatus): { text: string; className: string } {
  if (status === 'running') return { text: '运行中', className: 'border-emerald-500/40 text-emerald-300' }
  if (status === 'failed') return { text: '失败', className: 'border-rose-500/40 text-rose-300' }
  return { text: '已完成', className: 'border-cyan-500/40 text-cyan-300' }
}

export function StorageJobConsole({ jobs, outputRoot, selectedJobId, onSelectJob }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState<StorageJobStatus | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [streamError, setStreamError] = useState('')
  const logBoxRef = useRef<HTMLDivElement | null>(null)

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  )

  useEffect(() => {
    if (autoScroll && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
    }
  }, [autoScroll, lines])

  useEffect(() => {
    if (!selectedJobId || !outputRoot.trim()) {
      setLines([])
      setStatus(null)
      setStreamError('')
      return
    }

    const params = new URLSearchParams({ out: outputRoot })
    const source = new EventSource(`/api/crawl/storage/jobs/${encodeURIComponent(selectedJobId)}/stream?${params.toString()}`)

    setLines([])
    setStatus(selectedJob?.status ?? null)
    setStreamError('')

    const handle = (kind: LogEvent['type']) => (event: MessageEvent<string>) => {
      let payload: Record<string, unknown> | null = null
      try {
        payload = JSON.parse(String(event.data ?? ''))
      } catch {
        return
      }

      if (kind === 'init' || kind === 'done') {
        const nextLines = Array.isArray(payload?.lines) ? payload.lines.map(String) : []
        setLines(nextLines)
        if (payload?.status === 'running' || payload?.status === 'failed' || payload?.status === 'exited') {
          setStatus(payload.status)
        }
        if (kind === 'done') source.close()
        return
      }

      if (payload?.line) {
        setLines((current) => current.slice(-2499).concat(String(payload?.line)))
      }
    }

    source.addEventListener('init', handle('init'))
    source.addEventListener('log', handle('log'))
    source.addEventListener('done', handle('done'))
    source.onerror = () => {
      setStreamError('日志流已断开，可重新选择任务查看最新状态。')
      source.close()
    }

    return () => {
      source.close()
    }
  }, [outputRoot, selectedJob?.status, selectedJobId])

  return (
    <section className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
      <div className="min-w-0 rounded-md border border-slate-800">
        <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-400">目录任务</div>
        <div className="max-h-72 overflow-auto p-2">
          {jobs.length ? (
            jobs.map((job) => {
              const jobStatus = statusInfo(job.status)
              const isSelected = job.id === selectedJobId
              return (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => onSelectJob(job.id)}
                  className={`mb-2 w-full rounded-md border px-3 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-cyan-500/40 ${
                    isSelected ? 'border-cyan-500/50 bg-cyan-950/20' : 'border-slate-800 hover:bg-slate-900'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-slate-200">{job.id.slice(0, 8)}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${jobStatus.className}`}>{jobStatus.text}</span>
                  </div>
                  <div className="mt-2 text-xs text-slate-400">
                    {storageActionLabel[job.action]} · {storageTargetLabel[job.target]}
                  </div>
                </button>
              )
            })
          ) : (
            <div className="p-3 text-sm text-slate-500">暂无目录任务</div>
          )}
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-md border border-slate-800 bg-black">
        <div className="flex h-11 items-center justify-between border-b border-slate-800 px-3">
          <div className="flex items-center gap-2 text-sm text-slate-200">
            <Terminal className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <span>目录任务日志</span>
            {selectedJob && status ? (
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusInfo(status).className}`}>
                {statusInfo(status).text}
              </span>
            ) : null}
          </div>
          <label className="flex h-9 items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} className="accent-cyan-500" />
            自动滚动
          </label>
        </div>

        <div ref={logBoxRef} className="h-[360px] overflow-auto p-3 font-mono text-xs leading-5 text-slate-300">
          {selectedJob ? (
            lines.length ? (
              lines.map((line, index) => (
                <div
                  key={`${index}-${line.slice(0, 20)}`}
                  className={`whitespace-pre-wrap break-words ${
                    line.includes('MSG') || line.toLowerCase().includes('error') ? 'text-rose-300' : ''
                  }`}
                >
                  {line}
                </div>
              ))
            ) : (
              <div className="grid h-full place-items-center text-slate-600">正在等待任务日志...</div>
            )
          ) : (
            <div className="grid h-full place-items-center text-slate-600">选择一个目录任务查看日志</div>
          )}
        </div>

        {streamError ? <div className="border-t border-slate-800 px-3 py-2 text-xs text-amber-300">{streamError}</div> : null}
      </div>
    </section>
  )
}
