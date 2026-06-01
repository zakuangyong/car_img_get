import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { downloadFileByUrl, getFilters, getImages, imageUrl, type FiltersResponse, type ImagesResponse } from '@/lib/api'
import { useSelectionStore } from '@/stores/selection'

export default function Home() {
  const [sp, setSp] = useSearchParams()
  const [filters, setFilters] = useState<FiltersResponse | null>(null)
  const [list, setList] = useState<ImagesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [downloading, setDownloading] = useState(false)

  const selected = useSelectionStore((s) => s.selected)
  const toggleSelected = useSelectionStore((s) => s.toggle)
  const addManySelected = useSelectionStore((s) => s.addMany)
  const clearSelected = useSelectionStore((s) => s.clear)
  const selectedCount = Object.keys(selected).length

  function sanitizeFileNamePart(s: string): string {
    const v = String(s ?? '').trim() || 'unknown'
    return v.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'unknown'
  }

  function extFromPath(p: string): string {
    const b = String(p ?? '').split('?')[0].split('#')[0]
    const dot = b.lastIndexOf('.')
    if (dot < 0) return '.png'
    const ext = b.slice(dot)
    return ext && ext.length <= 10 ? ext : '.png'
  }

  const brand = sp.get('brand') ?? ''
  const model = sp.get('model') ?? ''
  const year = sp.get('year') ?? ''
  const page = Number(sp.get('page') ?? '1') || 1
  const pageSize = Number(sp.get('pageSize') ?? '60') || 60

  useEffect(() => {
    let cancelled = false
    getFilters()
      .then((v) => {
        if (cancelled) return
        setFilters(v)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e?.message ?? e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    getImages({ brand, model, year, page, pageSize })
      .then((v) => {
        if (cancelled) return
        setList(v)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e?.message ?? e))
        setList(null)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [brand, model, year, page, pageSize])

  useEffect(() => {
    clearSelected()
  }, [brand, clearSelected])

  const brandOptions = filters?.brands ?? []
  const modelOptions = useMemo(() => {
    if (!filters || !brand) return []
    return filters.modelsByBrand[brand] ?? []
  }, [filters, brand])

  const yearOptions = useMemo(() => {
    if (!filters || !brand || !model) return []
    return filters.yearsByBrandModel?.[brand]?.[model] ?? []
  }, [filters, brand, model])

  const total = list?.total ?? 0
  const items = list?.items ?? []
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  function update(params: Record<string, string>) {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(params)) {
      if (!v) next.delete(k)
      else next.set(k, v)
    }
    if (params.brand !== undefined || params.model !== undefined || params.year !== undefined) {
      next.set('page', '1')
    }
    setSp(next)
  }

  async function onDownloadSelected() {
    if (downloading) return
    const imgs = Object.values(selected)
    if (imgs.length === 0) return
    setDownloading(true)
    setError('')
    try {
      const counters: Record<string, number> = {}
      const ordered = imgs.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
      for (const img of ordered) {
        const modelName = sanitizeFileNamePart(String(img.model ?? img.brand ?? 'unknown'))
        counters[modelName] = (counters[modelName] ?? 0) + 1
        const seq = String(counters[modelName]).padStart(4, '0')
        const filename = `${modelName}_${seq}${extFromPath(img.filePath)}`
        await downloadFileByUrl(imageUrl(img.filePath), filename)
        await new Promise((r) => setTimeout(r, 120))
      }
    } catch (e) {
      setError(String((e as { message?: unknown } | null | undefined)?.message ?? e))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3">
          <div className="text-lg font-semibold">图片数据集浏览</div>
          <div className="text-sm text-slate-300">
            {brand || model || year ? (
              <span>{[brand, model, year].filter(Boolean).join(' / ')}</span>
            ) : (
              <span>全部</span>
            )}
          </div>
          <div className="text-xs text-slate-400">{loading ? '加载中…' : total ? `共 ${total} 张` : ''}</div>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1600px] grid-cols-[280px_1fr] gap-4 px-4 py-4">
        <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs text-slate-400">品牌</div>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm"
                value={brand}
                onChange={(e) => update({ brand: e.target.value, model: '', year: '' })}
              >
                <option value="">全部</option>
                {brandOptions.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs text-slate-400">车型</div>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm disabled:opacity-50"
                value={model}
                disabled={!brand}
                onChange={(e) => update({ model: e.target.value, year: '' })}
              >
                <option value="">{brand ? '全部' : '先选择品牌'}</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs text-slate-400">年份</div>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm disabled:opacity-50"
                value={year}
                disabled={!brand || !model}
                onChange={(e) => update({ year: e.target.value })}
              >
                <option value="">{brand && model ? '全部' : '先选择车型'}</option>
                {yearOptions.map((y) => (
                  <option key={String(y)} value={String(y)}>
                    {String(y)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm hover:bg-slate-900"
                onClick={() => update({ brand: '', model: '', year: '' })}
              >
                清空筛选
              </button>
            </div>

            {error ? <div className="rounded-md border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-200">{error}</div> : null}
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-300">结果：{loading ? '加载中…' : `${total} 张`}</div>
              <div className="text-xs text-slate-400">已选：{selectedCount}</div>
              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs disabled:opacity-50"
                disabled={items.length === 0}
                onClick={() =>
                  addManySelected(items.map((x) => ({ id: x.id, filePath: x.filePath, brand: x.brand, model: x.model, year: x.year })))
                }
              >
                全选本页
              </button>
              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs disabled:opacity-50"
                disabled={selectedCount === 0}
                onClick={() => clearSelected()}
              >
                清空选中
              </button>
              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs disabled:opacity-50"
                disabled={selectedCount === 0 || downloading}
                onClick={() => void onDownloadSelected()}
              >
                {downloading ? '下载中…' : '下载选中'}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm disabled:opacity-50"
                disabled={page <= 1}
                onClick={() => update({ page: String(Math.max(1, page - 1)) })}
              >
                上一页
              </button>
              <div className="text-xs text-slate-400">
                {page} / {totalPages}
              </div>
              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm disabled:opacity-50"
                disabled={page >= totalPages}
                onClick={() => update({ page: String(Math.min(totalPages, page + 1)) })}
              >
                下一页
              </button>
            </div>
          </div>

          {items.length === 0 && !loading ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-6 text-sm text-slate-300">没有匹配的图片</div>
          ) : null}

          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {items.map((it) => {
              const isSelected = Boolean(selected[it.id])
              return (
                <div
                  key={it.id}
                  className={`group relative overflow-hidden rounded-lg border bg-slate-900/30 hover:border-slate-600 ${
                    isSelected ? 'border-indigo-500' : 'border-slate-800'
                  }`}
                >
                  <Link
                    to={{
                      pathname: `/image/${it.id}`,
                      search: new URLSearchParams({ brand, model, year }).toString(),
                    }}
                    className="block"
                  >
                    <div className="aspect-[4/3] w-full overflow-hidden bg-slate-900">
                      <img className="h-full w-full object-cover" src={imageUrl(it.filePath)} loading="lazy" />
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="truncate text-xs text-slate-400">{it.filePath.split('/').pop()}</div>
                      <div className="truncate text-sm text-slate-200">
                        {(it.brand ?? '-') + ' / ' + (it.model ?? '-') + ' / ' + (it.year ?? '-')}
                      </div>
                    </div>
                  </Link>

                  <label className="absolute left-2 top-2 z-10 flex items-center gap-2 rounded bg-slate-950/70 px-2 py-1 text-xs text-slate-100">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected({ id: it.id, filePath: it.filePath, brand: it.brand, model: it.model, year: it.year })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    选中
                  </label>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
