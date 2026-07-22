import { Database, FileJson, FolderCog, RefreshCw, TriangleAlert } from 'lucide-react'
import type { StorageSummaryItem, StorageTarget } from '@/lib/api'
import { formatBytes, storageTargetLabel } from '@/lib/crawler-storage'

type Props = {
  root: string
  items: StorageSummaryItem[]
  loading: boolean
  selectedTarget: StorageTarget
  onRefresh: () => void
  onSelectTarget: (target: StorageTarget) => void
}

function summaryCountLabel(item: StorageSummaryItem): string {
  if (item.kind === 'manifest') return `${item.recordCount ?? 0} 条记录`
  return `${item.fileCount} 个文件`
}

function summaryIcon(item: StorageSummaryItem) {
  if (item.kind === 'manifest') return FileJson
  if (item.kind === 'virtual') return FolderCog
  return Database
}

export function StorageSummaryCards({ root, items, loading, selectedTarget, onRefresh, onSelectTarget }: Props) {
  return (
    <section className="overflow-hidden rounded-md border border-slate-800">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-100">目录总览</div>
          <div className="mt-1 text-xs text-slate-500">{root || '等待输出目录'}</div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          刷新
        </button>
      </div>

      <div className="grid gap-px bg-slate-800 md:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => {
          const Icon = summaryIcon(item)
          const isSelected = selectedTarget === item.target
          return (
            <button
              key={item.target}
              type="button"
              onClick={() => onSelectTarget(item.target)}
              className={`min-w-0 p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 ${
                isSelected
                  ? 'bg-cyan-950/30'
                  : 'bg-slate-950 hover:bg-slate-900'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs text-slate-400">{storageTargetLabel[item.target]}</div>
                  <div className="mt-1 truncate text-lg font-semibold text-slate-100">{summaryCountLabel(item)}</div>
                </div>
                <Icon className={`h-5 w-5 shrink-0 ${item.exists ? 'text-cyan-300' : 'text-slate-600'}`} aria-hidden="true" />
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
                <span>{formatBytes(item.totalBytes)}</span>
                <span>{item.exists ? '已发现' : '未发现'}</span>
              </div>
              {item.warnings.length ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-amber-300">
                  <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.warnings[0]}</span>
                </div>
              ) : null}
            </button>
          )
        })}
      </div>
    </section>
  )
}
