import { Router } from 'express'
import {
  executeStorageAction,
  getJob,
  getJobLogTail,
  getCrawlPreviewSource,
  getCrawlPreviews,
  getPipelineModelStatus,
  getStorageItems,
  getStorageJob,
  getStorageSummary,
  listJobs,
  listStorageJobs,
  planStorageAction,
  startJob,
  stopJob,
  subscribeStorageJob,
  subscribeJob,
} from '../services/crawl.js'

const router = Router()

router.get('/crawl/previews', (req, res) => {
  const kind = String(req.query.kind ?? '')
  if (kind !== 'accepted' && kind !== 'rejected') {
    res.status(400).json({ error: 'kind must be accepted or rejected' })
    return
  }
  try {
    res.json(getCrawlPreviews(req.query.out, kind, req.query.limit))
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message ?? error) })
  }
})

router.get('/crawl/previews/image', async (req, res) => {
  const kind = String(req.query.kind ?? '')
  if (kind !== 'accepted' && kind !== 'rejected') {
    res.status(400).end()
    return
  }
  try {
    const source = getCrawlPreviewSource(req.query.out, kind, req.query.token)
    if (!source) {
      res.status(404).end()
      return
    }
    if (source.localPath) {
      res.setHeader('Cache-Control', 'no-store, max-age=0')
      res.sendFile(source.localPath)
      return
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.redirect(302, String(source.remoteUrl))
  } catch {
    res.status(502).end()
  }
})

router.get('/crawl/pipeline-status', (_req, res) => {
  res.json(getPipelineModelStatus())
})

router.get('/crawl/storage/summary', (req, res) => {
  try {
    res.json(getStorageSummary(String(req.query.out ?? '')))
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message ?? error) })
  }
})

router.get('/crawl/storage/items', (req, res) => {
  try {
    res.json(getStorageItems(String(req.query.out ?? ''), String(req.query.target ?? '') as any))
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message ?? error) })
  }
})

router.post('/crawl/storage/plan', (req, res) => {
  try {
    res.json(planStorageAction(String(req.body?.out ?? ''), req.body))
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message ?? error) })
  }
})

router.post('/crawl/storage/execute', (req, res) => {
  try {
    res.json(executeStorageAction(String(req.body?.out ?? ''), req.body))
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message ?? error) })
  }
})

router.get('/crawl/storage/jobs', (req, res) => {
  try {
    res.json(listStorageJobs(String(req.query.out ?? '')))
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message ?? error) })
  }
})

router.get('/crawl/storage/jobs/:id/stream', (req, res) => {
  const id = String(req.params.id ?? '').trim()
  const outputRoot = String(req.query.out ?? '')
  let job
  try {
    job = getStorageJob(id, outputRoot)
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message ?? error) })
    return
  }
  if (!job) {
    res.status(404).end()
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ;(res as { flushHeaders?: () => void }).flushHeaders?.()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  let finished = false
  let unsub: (() => void) | null = null
  let ping: ReturnType<typeof setInterval> | null = null
  const finish = () => {
    if (finished) return
    finished = true
    if (ping) clearInterval(ping)
    if (unsub) unsub()
    res.end()
  }

  const sendTerminal = () => {
    const summary = getStorageJob(id, outputRoot)
    if (!summary || summary.status === 'running') return false
    send('done', { status: summary.status, endedAt: summary.endedAt, lines: summary.lines })
    finish()
    return true
  }

  send('init', { lines: job.lines, status: job.status })
  if (sendTerminal()) return

  unsub = subscribeStorageJob(id, (line) => {
    send('log', { line })
    sendTerminal()
  }, outputRoot)

  ping = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`)
  }, 10000)

  req.on('close', () => {
    finish()
  })
})

router.get('/crawl/jobs', (req, res) => {
  res.json({ items: listJobs() })
})

router.get('/crawl/jobs/:id', (req, res) => {
  const id = String(req.params.id ?? '').trim()
  const job = getJob(id)
  if (!job) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(job)
})

router.post('/crawl/jobs', (req, res) => {
  const input = (req.body ?? {}) as Record<string, unknown>
  const job = startJob(input)
  res.json(job)
})

router.post('/crawl/jobs/:id/stop', (req, res) => {
  const id = String(req.params.id ?? '').trim()
  const job = stopJob(id)
  if (!job) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(job)
})

router.get('/crawl/jobs/:id/stream', (req, res) => {
  const id = String(req.params.id ?? '').trim()
  const tail = getJobLogTail(id)
  if (!tail) {
    res.status(404).end()
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ;(res as any).flushHeaders?.()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  send('init', { lines: tail.lines })

  const unsub = subscribeJob(id, (line) => {
    send('log', { line })
  })

  const ping = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`)
  }, 10000)

  req.on('close', () => {
    clearInterval(ping)
    if (unsub) unsub()
  })
})

export default router
