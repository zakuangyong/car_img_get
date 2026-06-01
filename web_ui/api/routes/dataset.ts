import { Router } from 'express'
import { filterItems, getDatasetIndex } from '../services/dataset.js'

const router = Router()

router.get('/filters', async (req, res, next) => {
  try {
    const idx = await getDatasetIndex()
    res.json(idx.filters)
  } catch (e) {
    next(e)
  }
})

router.get('/images', async (req, res, next) => {
  try {
    const idx = await getDatasetIndex()
    const page = Math.max(1, Number(req.query.page ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 60) || 60))

    const filtered = filterItems(idx.items, {
      brand: String(req.query.brand ?? ''),
      model: String(req.query.model ?? ''),
      year: String(req.query.year ?? ''),
    })

    const total = filtered.length
    const start = (page - 1) * pageSize
    const slice = filtered.slice(start, start + pageSize).map((it) => ({
      id: it.id,
      filePath: it.filePath,
      brand: it.brand,
      model: it.model,
      year: it.year,
    }))

    res.json({ total, items: slice })
  } catch (e) {
    next(e)
  }
})

router.get('/images/:id', async (req, res, next) => {
  try {
    const idx = await getDatasetIndex()
    const id = String(req.params.id ?? '').trim()
    const it = idx.byId.get(id)
    if (!it) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json(it)
  } catch (e) {
    next(e)
  }
})

router.get('/images/:id/nav', async (req, res, next) => {
  try {
    const idx = await getDatasetIndex()
    const id = String(req.params.id ?? '').trim()
    const filtered = filterItems(idx.items, {
      brand: String(req.query.brand ?? ''),
      model: String(req.query.model ?? ''),
      year: String(req.query.year ?? ''),
    })
    const pos = filtered.findIndex((x) => String(x.id) === id)
    if (pos < 0) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const prev = pos > 0 ? filtered[pos - 1]?.id : null
    const nextId = pos + 1 < filtered.length ? filtered[pos + 1]?.id : null
    res.json({ prev, next: nextId, index: pos, total: filtered.length })
  } catch (e) {
    next(e)
  }
})

export default router
