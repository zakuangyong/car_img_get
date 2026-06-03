/**
 * This is a API server
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import datasetRoutes from './routes/dataset.js'
import { Readable } from 'stream'

// load env
dotenv.config()

const app: express.Application = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/**
 * API Routes
 */
app.use('/api', datasetRoutes)

function normalizeBaseUrl(u: string): string {
  const s = String(u ?? '').trim()
  if (!s) return ''
  return s.endsWith('/') ? s : `${s}/`
}

const datasetRoot = String(process.env.DATASET_ROOT ?? '').trim()
  ? path.resolve(String(process.env.DATASET_ROOT))
  : path.resolve(process.cwd(), '..', 'dataset_png')

const datasetUrlBase = normalizeBaseUrl(String(process.env.DATASET_URL_BASE ?? ''))

if (datasetUrlBase) {
  app.get('/images/*', async (req: Request, res: Response) => {
    const rel = String(req.params[0] ?? '').replace(/\\/g, '/')
    if (!rel || rel.includes('..')) {
      res.status(400).end()
      return
    }
    const url = `${datasetUrlBase}${rel}`
    const r = await fetch(url)
    if (!r.ok) {
      res.status(r.status).end()
      return
    }
    const ct = r.headers.get('content-type')
    if (ct) res.setHeader('content-type', ct)
    const cl = r.headers.get('content-length')
    if (cl) res.setHeader('content-length', cl)
    const cc = r.headers.get('cache-control')
    if (cc) res.setHeader('cache-control', cc)
    if (!r.body) {
      res.status(502).end()
      return
    }
    Readable.fromWeb(r.body as any).pipe(res)
  })
} else if (fs.existsSync(datasetRoot)) {
  app.use('/images', express.static(datasetRoot))
}

const webDist = path.resolve(process.cwd(), 'dist')
if (fs.existsSync(path.resolve(webDist, 'index.html'))) {
  app.use(express.static(webDist))
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/images')) {
      next()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }
    res.sendFile(path.resolve(webDist, 'index.html'))
  })
}

/**
 * health
 */
app.use(
  '/api/health',
  (req: Request, res: Response): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  void _next
  console.error('[api-error]', req.method, req.originalUrl, error)
  const exposeError = String(process.env.EXPOSE_ERROR ?? '').trim() === '1' || process.env.NODE_ENV !== 'production'
  res.status(500).json({
    success: false,
    error: 'Server internal error',
    message: exposeError ? String(error?.message ?? '') : undefined,
  })
})

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
