import { useEffect, useState } from 'react'
import type { StoragePlan } from '@/lib/api'
import { formatBytes, storageActionLabel, storageRiskLabel, storageTargetLabel } from '@/lib/crawler-storage'

type Props = {
  busy: boolean
  plan: StoragePlan | null
  onClose: () => void
  onConfirm: (confirmationText?: string) => Promise<void> | void
}

export function StorageActionDialog({ busy, plan, onClose, onConfirm }: Props) {
  const [typedText, setTypedText] = useState('')

  useEffect(() => {
    setTypedText('')
  }, [plan?.planToken])

  if (!plan) return null

  const needsTypedConfirmation = plan.requiresTypedConfirmation
  const canConfirm = !busy && (!needsTypedConfirmation || typedText === plan.confirmationText)

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="目录操作确认"
      onMouseDown={(event) => {
        if (busy) return
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-md border border-slate-700 bg-slate-950 shadow-2xl">
        <div className="border-b border-slate-800 px-4 py-3">
          <div className="text-sm font-semibold text-slate-100">执行预估</div>
          <div className="mt-1 text-xs text-slate-500">
            {storageActionLabel[plan.action]} · {storageTargetLabel[plan.target]}
          </div>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3">
              <div className="text-xs text-slate-500">风险等级</div>
              <div className="mt-1 font-medium text-slate-100">{storageRiskLabel[plan.risk]}</div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3">
              <div className="text-xs text-slate-500">影响对象</div>
              <div className="mt-1 font-medium text-slate-100">{plan.fileCount} 个文件</div>
            </div>
            <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3">
              <div className="text-xs text-slate-500">预估体积</div>
              <div className="mt-1 font-medium text-slate-100">{formatBytes(plan.totalBytes)}</div>
            </div>
          </div>

          <div className="rounded-md border border-slate-800 bg-slate-900/20 p-3 text-xs text-slate-400">
            <div>影响预览：{plan.affectsPreview ? '是' : '否'}</div>
            <div className="mt-1">影响历史记录：{plan.affectsHistory ? '是' : '否'}</div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold text-slate-400">样本路径</div>
            {plan.samplePaths.length ? (
              <div className="max-h-40 overflow-auto rounded-md border border-slate-800 bg-black/40 p-3 font-mono text-xs text-slate-300">
                {plan.samplePaths.map((samplePath) => (
                  <div key={samplePath} className="truncate py-1">
                    {samplePath}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-slate-800 p-4 text-xs text-slate-500">
                当前计划没有命中文件，执行后不会产生实际变更。
              </div>
            )}
          </div>

          {needsTypedConfirmation ? (
            <div>
              <div className="mb-2 text-xs font-semibold text-amber-300">
                请输入确认文本 `{plan.confirmationText}` 继续
              </div>
              <input
                className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20"
                value={typedText}
                onChange={(event) => setTypedText(event.target.value)}
                placeholder={plan.confirmationText}
              />
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-10 items-center rounded-md border border-slate-700 px-4 text-sm transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void onConfirm(needsTypedConfirmation ? typedText : undefined)}
            disabled={!canConfirm}
            className="inline-flex h-10 items-center rounded-md bg-cyan-600 px-4 text-sm font-semibold text-white transition hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '执行中...' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  )
}
