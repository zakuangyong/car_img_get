import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getImage, getNav, imageUrl, type ImageMeta } from '@/lib/api'
import { buildImageMetaPanel } from '@/lib/image-detail-meta'

const PAGE_SHELL_CLASS = 'mx-auto max-w-[1680px] px-4'

export default function ImageDetail() {
  const { id = '' } = useParams()
  const [sp] = useSearchParams()
  const [meta, setMeta] = useState<ImageMeta | null>(null)
  const [nav, setNav] = useState<{ prev: string | null; next: string | null; index: number; total: number } | null>(null)
  const [error, setError] = useState<string>('')

  const brand = sp.get('brand') ?? ''
  const model = sp.get('model') ?? ''
  const year = sp.get('year') ?? ''

  useEffect(() => {
    let cancelled = false
    setError('')
    setMeta(null)
    getImage(id)
      .then((v) => {
        if (cancelled) return
        setMeta(v)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e?.message ?? e))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    let cancelled = false
    setNav(null)
    getNav(id, { brand, model, year })
      .then((v) => {
        if (cancelled) return
        setNav(v)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, brand, model, year])

  const backSearch = useMemo(() => {
    const q = new URLSearchParams()
    if (brand) q.set('brand', brand)
    if (model) q.set('model', model)
    if (year) q.set('year', year)
    return q.toString()
  }, [brand, model, year])
  const panel = useMemo(() => (meta ? buildImageMetaPanel(meta) : null), [meta])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className={`${PAGE_SHELL_CLASS} flex items-center justify-between py-3`}>
          <div className="flex items-center gap-2">
            <Link className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm hover:bg-slate-900" to={{ pathname: '/', search: backSearch }}>
              返回
            </Link>
            <div className="text-sm text-slate-300">{meta ? meta.filePath.split('/').pop() : id}</div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm hover:bg-slate-900 disabled:opacity-50"
              to={nav?.prev ? { pathname: `/image/${nav.prev}`, search: backSearch } : '#'}
              aria-disabled={!nav?.prev}
              onClick={(e) => {
                if (!nav?.prev) e.preventDefault()
              }}
            >
              上一张
            </Link>
            <Link
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm hover:bg-slate-900 disabled:opacity-50"
              to={nav?.next ? { pathname: `/image/${nav.next}`, search: backSearch } : '#'}
              aria-disabled={!nav?.next}
              onClick={(e) => {
                if (!nav?.next) e.preventDefault()
              }}
            >
              下一张
            </Link>
          </div>
        </div>
      </div>

      <div className={`${PAGE_SHELL_CLASS} grid grid-cols-[minmax(0,1fr)_380px] gap-4 py-4`}>
        <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
          {error ? <div className="rounded-md border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-200">{error}</div> : null}
          {meta ? (
            <div className="flex items-center justify-center bg-slate-900/40 p-2">
              <img className="max-h-[75vh] w-auto max-w-full object-contain" src={imageUrl(meta.filePath)} />
            </div>
          ) : (
            <div className="p-6 text-sm text-slate-300">加载中…</div>
          )}
        </div>

        <div className="rounded-[20px] border border-slate-800 bg-slate-900/40 p-4 shadow-[0_20px_60px_rgba(2,6,23,0.35)]">
          <div className="mb-4 border-b border-slate-800/80 pb-4">
            <div className="text-[11px] uppercase tracking-[0.28em] text-cyan-400/80">Metadata</div>
            {panel ? (
              <>
                <div className="mt-3 text-xl text-slate-50">{panel.headline}</div>
                <div className="mt-1 whitespace-normal break-all text-xs leading-5 text-slate-400">{panel.subheadline}</div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {panel.summary.map((item) => (
                    <div
                      key={`${item.label}-${item.value}`}
                      className={`rounded-full border px-3 py-1.5 text-[11px] ${
                        item.tone === 'success'
                          ? 'border-emerald-800/70 bg-emerald-950/40 text-emerald-100'
                          : item.tone === 'warn'
                            ? 'border-amber-800/70 bg-amber-950/30 text-amber-100'
                            : item.tone === 'accent'
                              ? 'border-cyan-800/70 bg-cyan-950/30 text-cyan-100'
                              : 'border-slate-700/80 bg-slate-950/80 text-slate-200'
                      }`}
                    >
                      <span className="mr-1 text-current/70">{item.label}</span>
                      <span>{item.value}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
          {panel ? (
            <div className="max-h-[75vh] space-y-3 overflow-auto pr-1">
              {panel.sections.map((section) => (
                <section key={section.title} className="rounded-2xl border border-slate-800/80 bg-slate-950/70 p-3">
                  <div className="mb-3 text-[11px] uppercase tracking-[0.22em] text-slate-500">{section.title}</div>
                  <div className="space-y-2">
                    {section.items.map((item) => (
                      <div
                        key={`${section.title}-${item.label}`}
                        className={`grid gap-2 border-b border-slate-800/70 pb-2 text-sm last:border-b-0 last:pb-0 ${
                          item.multiline ? 'grid-cols-1' : 'grid-cols-[88px_1fr]'
                        }`}
                      >
                        <div className="text-xs text-slate-500">{item.label}</div>
                        <div className={`break-words text-slate-100 ${item.multiline ? 'text-xs leading-5' : ''}`}>
                          {item.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="text-sm text-slate-300">—</div>
          )}
        </div>
      </div>
    </div>
  )
}
