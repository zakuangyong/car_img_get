import type { StorageAction, StorageItemDetail, StorageTarget } from '@/lib/api'
import { formatBytes, storageActionLabel, storageTargetLabel } from '@/lib/crawler-storage'

type Props = {
  detail: StorageItemDetail | null
  loading: boolean
  planning: boolean
  onAction: (action: StorageAction, groupKey?: string) => void
}

const storageTargetActions: Record<StorageTarget, StorageAction[]> = {
  stage_original: ['export', 'delete'],
  stage_birefnet: ['export', 'delete'],
  stage_accepted: ['export', 'delete'],
  stage_rejected: ['export', 'cleanup', 'delete'],
  review_rejected: ['export', 'cleanup'],
  metadata: ['export', 'backup'],
  rejected_manifest: ['export', 'backup'],
  stage_part_files: ['export', 'cleanup'],
}

const storageGroupActions: Partial<Record<StorageTarget, StorageAction[]>> = {
  stage_original: ['export'],
  stage_birefnet: ['export'],
  stage_accepted: ['export'],
  stage_rejected: ['export', 'cleanup'],
  review_rejected: ['export'],
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '-'
}

export function StorageDetailPanel({ detail, loading, planning, onAction }: Props) {
  if (loading) {
    return (
      <div className="grid h-48 place-items-center rounded-md border border-slate-800 text-sm text-slate-500">
        正在读取目录详情...
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="grid h-48 place-items-center rounded-md border border-dashed border-slate-800 text-sm text-slate-500">
        当前还没有目录详情，请先选择目标。
      </div>
    )
  }

  const { summary } = detail
  const actions = storageTargetActions[detail.target]
  const groupActions = storageGroupActions[detail.target] ?? []
  const canTargetAction = summary.fileCount > 0 || (summary.recordCount ?? 0) > 0
  const allowGroupAction = summary.kind === 'directory' && groupActions.length > 0

  return (
    <section className="rounded-md border border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-4 py-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-100">{storageTargetLabel[detail.target]}</div>
          <div className="mt-1 break-all text-xs text-slate-500">{summary.relativePath}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onAction(action)}
              disabled={planning || !canTargetAction}
              className="inline-flex h-9 items-center rounded-md border border-slate-700 px-3 text-sm transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {storageActionLabel[action]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 border-b border-slate-800 px-4 py-4 md:grid-cols-4">
        <div className="rounded-md border border-slate-800 bg-slate-900/30 p-3">
          <div className="text-xs text-slate-500">可见对象</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {summary.kind === 'manifest' ? summary.recordCount ?? 0 : summary.fileCount}
          </div>
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-900/30 p-3">
          <div className="text-xs text-slate-500">总大小</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">{formatBytes(summary.totalBytes)}</div>
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-900/30 p-3">
          <div className="text-xs text-slate-500">最近更新时间</div>
          <div className="mt-1 text-sm font-medium text-slate-100">{formatTime(summary.latestMtimeMs)}</div>
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-900/30 p-3">
          <div className="text-xs text-slate-500">状态</div>
          <div className="mt-1 text-sm font-medium text-slate-100">{summary.exists ? '已发现' : '目标不存在'}</div>
        </div>
      </div>

      {summary.warnings.length ? (
        <div className="border-b border-slate-800 px-4 py-3 text-sm text-amber-300">
          {summary.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <div className="min-w-0">
          <div className="mb-2 text-xs font-semibold text-slate-400">分组明细</div>
          {detail.groups.length ? (
            <div className="overflow-hidden rounded-md border border-slate-800">
              <div className="max-h-[360px] overflow-auto">
                {detail.groups.map((group) => (
                  <div key={group.key} className="border-b border-slate-800 px-3 py-3 last:border-b-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-100">{group.label}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {group.fileCount} 个文件 · {formatBytes(group.totalBytes)}
                        </div>
                      </div>
                      {allowGroupAction ? (
                        <div className="flex flex-wrap gap-2">
                          {groupActions.map((action) => (
                            <button
                              key={`${group.key}-${action}`}
                              type="button"
                              onClick={() => onAction(action, group.key)}
                              disabled={planning}
                              className="inline-flex h-8 items-center rounded-md border border-slate-700 px-2.5 text-xs transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {storageActionLabel[action]}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-slate-800 p-6 text-sm text-slate-500">
              当前目标暂无可展示内容
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-400">样本路径</div>
            {detail.samples.length ? (
              <div className="max-h-[220px] overflow-auto rounded-md border border-slate-800 bg-black/30 p-3">
                {detail.samples.map((sample) => (
                  <div key={`${sample.path}-${sample.mtimeMs}`} className="border-b border-slate-900 py-2 last:border-b-0">
                    <div className="break-all font-mono text-xs text-slate-300">{sample.path}</div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {formatBytes(sample.size)} · {formatTime(sample.mtimeMs)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-slate-800 p-4 text-sm text-slate-500">
                当前目标没有样本路径。
              </div>
            )}
          </div>

          {detail.records?.length ? (
            <div>
              <div className="mb-2 text-xs font-semibold text-slate-400">最近记录</div>
              <div className="max-h-[240px] overflow-auto rounded-md border border-slate-800 bg-black/30 p-3">
                {detail.records.map((record, index) => (
                  <pre key={`${index}-${JSON.stringify(record)}`} className="mb-3 whitespace-pre-wrap break-words text-xs text-slate-300 last:mb-0">
                    {JSON.stringify(record, null, 2)}
                  </pre>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
