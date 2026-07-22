import type { ImageMeta } from './api'

export type MetaPanelItem = {
  label: string
  value: string
  tone?: 'default' | 'accent' | 'success' | 'warn'
  multiline?: boolean
}

export type MetaPanelSection = {
  title: string
  items: MetaPanelItem[]
}

export type MetaPanelData = {
  headline: string
  subheadline: string
  summary: MetaPanelItem[]
  sections: MetaPanelSection[]
}

type FieldSpec = {
  label: string
  keys: string[]
}

type SectionSpec = {
  title: string
  fields: FieldSpec[]
}

const SUMMARY_FIELDS: FieldSpec[] = [
  { label: '品牌', keys: ['brand'] },
  { label: '车型', keys: ['model'] },
  { label: '年份', keys: ['year'] },
  { label: '视角', keys: ['view'] },
  { label: '质量', keys: ['quality'] },
  { label: '来源', keys: ['view_source'] },
  { label: '云检测', keys: ['cloud_detector'] },
]

const SECTION_DEFS: SectionSpec[] = [
  {
    title: '基础信息',
    fields: [
      { label: 'id', keys: ['id'] },
      { label: 'seriesId', keys: ['seriesId', 'seriesid', 'series_id'] },
      { label: 'specId', keys: ['specId', 'specid', 'spec_id'] },
      { label: 'category', keys: ['category', 'categoryid', 'category_id'] },
      { label: 'picId', keys: ['picId', 'picid', 'pic_id'] },
      { label: 'typeid', keys: ['typeid', 'image_typeid'] },
    ],
  },
  {
    title: '图像信息',
    fields: [
      { label: 'width', keys: ['width'] },
      { label: 'height', keys: ['height'] },
      { label: 'aspect_ratio', keys: ['aspect_ratio'] },
      { label: 'body', keys: ['body'] },
      { label: 'colorname', keys: ['colorname'] },
    ],
  },
  {
    title: '视角与质量',
    fields: [
      { label: 'view', keys: ['view'] },
      { label: 'view_score', keys: ['view_score', 'view_confidence'] },
      { label: 'view_source', keys: ['view_source'] },
      { label: 'y_symmetry', keys: ['y_symmetry'] },
      { label: 'std_ratio', keys: ['std_ratio'] },
      { label: 'cloud_detector', keys: ['cloud_detector'] },
      { label: 'quality', keys: ['quality'] },
    ],
  },
  {
    title: '来源与路径',
    fields: [
      { label: 'url', keys: ['url'] },
      { label: 'savedPath', keys: ['savedPath', 'saved_path'] },
      { label: 'filePath', keys: ['filePath'] },
    ],
  },
]

export function buildImageMetaPanel(meta: ImageMeta): MetaPanelData {
  const used = new Set<string>()
  const summary = SUMMARY_FIELDS.map((field) => buildSummaryItem(meta, field, used)).filter(Boolean) as MetaPanelItem[]
  const headline = [meta.brand, meta.model].map(formatOptionalValue).filter(Boolean).join(' ')
  const subheadline = [meta.year, meta.view].map(formatOptionalValue).filter(Boolean).join(' · ')
  const fallbackPath = formatOptionalValue(meta.filePath ?? meta.saved_path ?? '')

  const sections = SECTION_DEFS.map((section) => {
    const items = section.fields.map((field) => buildSectionItem(meta, field, used)).filter(Boolean) as MetaPanelItem[]

    return { title: section.title, items }
  }).filter((section) => section.items.length > 0)

  const otherItems = Object.entries(meta)
    .filter(([key]) => !used.has(key))
    .map(([key, value]) => toPanelItem(key, value, key))
    .filter(Boolean) as MetaPanelItem[]

  if (otherItems.length > 0) {
    sections.push({ title: '其他信息', items: otherItems })
  }

  return {
    headline: headline || String(meta.id ?? '未命名样本'),
    subheadline: subheadline || fallbackPath || '',
    summary,
    sections,
  }
}

function buildSummaryItem(meta: ImageMeta, field: FieldSpec, used: Set<string>): MetaPanelItem | null {
  const match = resolveField(meta, field.keys)
  if (!match) return null
  used.add(match.key)
  return toPanelItem(field.label, match.value, match.key)
}

function buildSectionItem(meta: ImageMeta, field: FieldSpec, used: Set<string>): MetaPanelItem | null {
  const match = resolveField(meta, field.keys)
  if (!match) return null
  used.add(match.key)
  return toPanelItem(match.key, match.value, match.key)
}

function resolveField(meta: ImageMeta, keys: string[]): { key: string; value: unknown } | null {
  for (const key of keys) {
    const value = meta[key]
    if (!isBlankValue(value)) {
      return { key, value }
    }
  }

  return null
}

function toPanelItem(label: string, value: unknown, key: string): MetaPanelItem | null {
  if (isBlankValue(value)) return null
  const formattedValue = formatMetaValue(value)

  return {
    label,
    value: formattedValue,
    multiline: shouldUseMultiline(key, formattedValue),
    tone: resolveTone(key, formattedValue),
  }
}

function isBlankValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

function formatOptionalValue(value: unknown): string {
  if (isBlankValue(value)) return ''
  return formatMetaValue(value)
}

function formatMetaValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function shouldUseMultiline(key: string, value: string): boolean {
  const normalizedKey = key.toLowerCase()
  if (normalizedKey === 'url' || normalizedKey === 'savedpath' || normalizedKey === 'saved_path' || normalizedKey === 'filepath') {
    return true
  }

  if (value.length < 32) return false
  if (normalizedKey.includes('url') || normalizedKey.includes('path')) return true
  return /^https?:\/\//i.test(value) || /[\\/]/.test(value)
}

function resolveTone(key: string, value: string): MetaPanelItem['tone'] {
  const normalizedKey = key.toLowerCase()

  if (normalizedKey === 'quality') {
    if (/(accept|pass|ok|good)/i.test(value)) return 'success'
    if (/(reject|fail|bad|error)/i.test(value)) return 'warn'
  }

  if (normalizedKey === 'view' || normalizedKey === 'view_source') {
    return 'accent'
  }

  return 'default'
}
