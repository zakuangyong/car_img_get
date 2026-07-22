import { useEffect, useRef, useState } from 'react'
import {
  executeStorageAction,
  getStorageItems,
  getStorageSummary,
  listStorageJobs,
  planStorageAction,
  type StorageAction,
  type StorageItemDetail,
  type StorageJobListItem,
  type StoragePlan,
  type StorageSummaryItem,
  type StorageTarget,
} from '@/lib/api'
import { StorageActionDialog } from './StorageActionDialog'
import { StorageDetailPanel } from './StorageDetailPanel'
import { StorageJobConsole } from './StorageJobConsole'
import { StorageSummaryCards } from './StorageSummaryCards'

type Props = {
  outputRoot: string
  onMutated: () => void
}

export function StoragePanel({ outputRoot, onMutated }: Props) {
  const normalizedOutputRoot = outputRoot.trim()
  const sessionRef = useRef(0)
  const summaryRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const jobsRequestRef = useRef(0)
  const [root, setRoot] = useState('')
  const [items, setItems] = useState<StorageSummaryItem[]>([])
  const [selectedTarget, setSelectedTarget] = useState<StorageTarget>('stage_rejected')
  const [detail, setDetail] = useState<StorageItemDetail | null>(null)
  const [jobs, setJobs] = useState<StorageJobListItem[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [watchJobId, setWatchJobId] = useState<string | null>(null)
  const [pendingPlan, setPendingPlan] = useState<StoragePlan | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState('')

  const hasOutputRoot = normalizedOutputRoot.length > 0

  function isCurrentRequest(requestId: number, requestRef: { current: number }, session: number) {
    return requestRef.current === requestId && sessionRef.current === session
  }

  async function refreshSummary(preferredTarget?: StorageTarget) {
    const session = sessionRef.current
    const requestId = summaryRequestRef.current + 1
    summaryRequestRef.current = requestId
    if (!hasOutputRoot) {
      setRoot('')
      setItems([])
      return
    }

    setLoadingSummary(true)
    try {
      const response = await getStorageSummary(normalizedOutputRoot)
      if (!isCurrentRequest(requestId, summaryRequestRef, session)) return
      setRoot(response.root)
      setItems(response.items)
      const desiredTarget = preferredTarget ?? selectedTarget
      const nextTarget = response.items.find((item) => item.target === desiredTarget)?.target ?? response.items[0]?.target
      if (nextTarget) setSelectedTarget((current) => (current === nextTarget ? current : nextTarget))
    } finally {
      if (isCurrentRequest(requestId, summaryRequestRef, session)) {
        setLoadingSummary(false)
      }
    }
  }

  async function refreshDetail(target = selectedTarget) {
    const session = sessionRef.current
    const requestId = detailRequestRef.current + 1
    detailRequestRef.current = requestId
    if (!hasOutputRoot) {
      setDetail(null)
      return
    }

    setLoadingDetail(true)
    try {
      const nextDetail = await getStorageItems(normalizedOutputRoot, target)
      if (!isCurrentRequest(requestId, detailRequestRef, session)) return
      setDetail(nextDetail)
    } finally {
      if (isCurrentRequest(requestId, detailRequestRef, session)) {
        setLoadingDetail(false)
      }
    }
  }

  async function refreshJobs() {
    const session = sessionRef.current
    const requestId = jobsRequestRef.current + 1
    jobsRequestRef.current = requestId
    if (!hasOutputRoot) {
      setJobs([])
      return
    }
    const response = await listStorageJobs(normalizedOutputRoot)
    if (!isCurrentRequest(requestId, jobsRequestRef, session)) return
    setJobs(response.items)
  }

  async function refreshAll(target = selectedTarget) {
    try {
      setError('')
      await Promise.all([refreshSummary(target), refreshDetail(target), refreshJobs()])
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason))
    }
  }

  useEffect(() => {
    sessionRef.current += 1
    setPendingPlan(null)
    setError('')
    setSelectedJobId(null)
    setWatchJobId(null)
    if (!hasOutputRoot) {
      setRoot('')
      setItems([])
      setDetail(null)
      setJobs([])
      return
    }
    void refreshAll(selectedTarget)
  }, [hasOutputRoot, normalizedOutputRoot])

  useEffect(() => {
    if (!hasOutputRoot) return
    void refreshDetail(selectedTarget).catch((reason) => {
      setError(String((reason as Error)?.message ?? reason))
    })
  }, [hasOutputRoot, normalizedOutputRoot, selectedTarget])

  useEffect(() => {
    if (!hasOutputRoot) return
    const timer = window.setInterval(() => {
      void refreshJobs().catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [hasOutputRoot, normalizedOutputRoot])

  useEffect(() => {
    if (!jobs.length) return
    if (!selectedJobId || !jobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(jobs[0].id)
    }
  }, [jobs, selectedJobId])

  useEffect(() => {
    if (!watchJobId) return
    const job = jobs.find((item) => item.id === watchJobId)
    if (!job || job.status === 'running') return

    setWatchJobId(null)
    void refreshAll(selectedTarget)
    onMutated()
  }, [jobs, onMutated, selectedTarget, watchJobId])

  async function requestAction(action: StorageAction, groupKey?: string) {
    if (!hasOutputRoot) return
    setPlanning(true)
    try {
      setError('')
      setPendingPlan(
        await planStorageAction({
          out: normalizedOutputRoot,
          target: selectedTarget,
          action,
          groupKey,
        }),
      )
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason))
    } finally {
      setPlanning(false)
    }
  }

  async function confirmAction(confirmationText?: string) {
    if (!pendingPlan || !hasOutputRoot) return
    setExecuting(true)
    try {
      setError('')
      const job = await executeStorageAction({
        out: normalizedOutputRoot,
        planToken: pendingPlan.planToken,
        target: pendingPlan.target,
        action: pendingPlan.action,
        confirmationText,
      })
      setPendingPlan(null)
      setSelectedJobId(job.id)
      setWatchJobId(job.id)
      await refreshJobs()
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason))
    } finally {
      setExecuting(false)
    }
  }

  if (!hasOutputRoot) {
    return (
      <section className="grid h-64 place-items-center rounded-md border border-dashed border-slate-800 text-sm text-slate-500">
        请输入有效的输出目录后，再查看目录管理工作区。
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <StorageSummaryCards
        root={root}
        items={items}
        loading={loadingSummary}
        selectedTarget={selectedTarget}
        onRefresh={() => {
          void refreshAll(selectedTarget)
        }}
        onSelectTarget={(target) => {
          setSelectedTarget(target)
        }}
      />

      <StorageDetailPanel
        detail={detail}
        loading={loadingDetail}
        planning={planning || executing}
        onAction={(action, groupKey) => {
          void requestAction(action, groupKey)
        }}
      />

      <StorageJobConsole
        jobs={jobs}
        outputRoot={normalizedOutputRoot}
        selectedJobId={selectedJobId}
        onSelectJob={setSelectedJobId}
      />

      {error ? (
        <div role="alert" className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      <StorageActionDialog
        busy={executing}
        plan={pendingPlan}
        onClose={() => {
          if (executing) return
          setPendingPlan(null)
        }}
        onConfirm={confirmAction}
      />
    </section>
  )
}
