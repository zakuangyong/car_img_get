import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getImage, getNav, imageUrl, type ImageMeta } from '@/lib/api'

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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3">
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

      <div className="mx-auto grid max-w-[1600px] grid-cols-[1fr_360px] gap-4 px-4 py-4">
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

        <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
          <div className="mb-2 text-sm font-semibold">元信息</div>
          {meta ? (
            <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950 p-3 text-xs text-slate-200">
              {JSON.stringify(meta, null, 2)}
            </pre>
          ) : (
            <div className="text-sm text-slate-300">—</div>
          )}
        </div>
      </div>
    </div>
  )
}

