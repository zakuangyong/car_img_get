import type { StorageAction, StorageRisk, StorageTarget } from './api'

export const storageTargetLabel: Record<StorageTarget, string> = {
  stage_original: 'Original 阶段',
  stage_birefnet: 'BiRefNet 阶段',
  stage_accepted: 'Accepted 阶段',
  stage_rejected: 'Rejected 阶段',
  review_rejected: 'Review 预览',
  metadata: 'metadata.jsonl',
  rejected_manifest: 'rejected.jsonl',
  stage_part_files: '.part 残留',
}

export const storageActionLabel: Record<StorageAction, string> = {
  export: '导出',
  cleanup: '清理',
  delete: '删除',
  backup: '备份',
}

export const storageRiskLabel: Record<StorageRisk, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
}

export function formatBytes(totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = totalBytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}
