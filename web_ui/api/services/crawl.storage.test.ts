import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'

import app from '../app.js'

import {
  executeStorageAction,
  getCrawlPreviews,
  getCrawlPreviewSource,
  getStorageJob,
  getStorageItems,
  getStorageSummary,
  listStorageJobs,
  planStorageAction,
  subscribeStorageJob,
  type StorageTarget,
} from './crawl.js'

async function waitForStorageJobTerminal(id: string, root: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = getStorageJob(id, root)?.status
    if (status && status !== 'running') return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timeout waiting for storage job ${id}`)
}

async function readResponseBodyUntilClose(response: Response, timeoutMs = 1000): Promise<string> {
  const reader = response.body?.getReader()
  assert.ok(reader, 'expected response body stream')
  const decoder = new TextDecoder()
  let text = ''

  while (true) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout waiting for storage stream to close')), timeoutMs),
      ),
    ])
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }

  text += decoder.decode()
  return text
}

test('getStorageSummary reports all stage targets, manifest records, and part file counts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root
  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(root, '_pipeline_stages', 'original', 'front'), { recursive: true })
  fs.mkdirSync(path.join(root, '_pipeline_stages', 'birefnet', 'front'), { recursive: true })
  fs.mkdirSync(path.join(root, '_pipeline_stages', 'accepted', 'front'), { recursive: true })
  fs.mkdirSync(path.join(root, '_pipeline_stages', 'rejected', 'front', 'clean_rejected'), { recursive: true })
  fs.mkdirSync(path.join(root, '_review', 'rejected'), { recursive: true })
  fs.writeFileSync(path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg'), Buffer.from('a'))
  fs.writeFileSync(path.join(root, '_pipeline_stages', 'original', 'front', 'b.jpg.part'), Buffer.from('b'))
  fs.writeFileSync(path.join(root, '_pipeline_stages', 'birefnet', 'front', 'mask.png'), Buffer.from('mask'))
  fs.writeFileSync(path.join(root, '_pipeline_stages', 'accepted', 'front', 'accepted.png'), Buffer.from('accepted'))
  fs.writeFileSync(
    path.join(root, '_pipeline_stages', 'rejected', 'front', 'clean_rejected', 'rejected.png'),
    Buffer.from('rejected'),
  )
  fs.writeFileSync(
    path.join(root, '_pipeline_stages', 'rejected', 'front', 'clean_rejected', 'rejected.png.part'),
    Buffer.from('part-2'),
  )
  fs.writeFileSync(path.join(root, '_review', 'rejected', 'preview.jpg'), Buffer.from('c'))
  fs.writeFileSync(path.join(root, '_review', 'rejected', 'ignored-preview.part'), Buffer.from('ignored-review-part'))
  fs.writeFileSync(path.join(root, 'ignored-root.part'), Buffer.from('ignored-root-part'))
  fs.writeFileSync(
    path.join(root, 'metadata.jsonl'),
    ['{"saved_path":"dataset_png/x.png"}', '{"saved_path":"dataset_png/y.png"}', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(root, 'rejected.jsonl'),
    ['{"reason":"clean_rejected","preview_path":"_review/rejected/preview.jpg"}', '{"reason":"size"}', ''].join('\n'),
  )

  const summary = getStorageSummary(root)
  const items = new Map(summary.items.map((item) => [item.target, item]))
  const expectedTargets: StorageTarget[] = [
    'stage_original',
    'stage_birefnet',
    'stage_accepted',
    'stage_rejected',
    'review_rejected',
    'metadata',
    'rejected_manifest',
    'stage_part_files',
  ]

  assert.equal(summary.root, root)
  assert.deepEqual(
    summary.items.map((item) => item.target),
    expectedTargets,
  )

  for (const target of expectedTargets) {
    assert.equal(items.get(target)?.exists, true, `${target} should exist`)
  }

  assert.equal(items.get('stage_original')?.fileCount, 1)
  assert.equal(items.get('stage_birefnet')?.fileCount, 1)
  assert.equal(items.get('stage_accepted')?.fileCount, 1)
  assert.equal(items.get('stage_rejected')?.fileCount, 1)
  assert.equal(items.get('review_rejected')?.fileCount, 1)
  assert.equal(items.get('metadata')?.fileCount, 1)
  assert.equal(items.get('rejected_manifest')?.fileCount, 1)
  assert.equal(items.get('stage_part_files')?.fileCount, 2)

  assert.equal(items.get('metadata')?.recordCount, 2)
  assert.equal(items.get('rejected_manifest')?.recordCount, 2)
  assert.equal(items.get('stage_original')?.recordCount, undefined)
  assert.equal(items.get('stage_part_files')?.recordCount, undefined)
  assert.equal(
    items.get('stage_part_files')?.fileCount,
    2,
    'stage_part_files should ignore .part files outside _pipeline_stages',
  )
})

test('getStorageSummary counts manifest records without fs.readFileSync whole-file loading', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-stream-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  const originalReadFileSync = fs.readFileSync
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    fs.readFileSync = originalReadFileSync
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.writeFileSync(path.join(root, 'metadata.jsonl'), ['{"saved_path":"a.png"}', '{"saved_path":"b.png"}', ''].join('\n'))
  fs.writeFileSync(path.join(root, 'rejected.jsonl'), ['{"reason":"clean"}', '{"reason":"size"}', ''].join('\n'))

  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, options?: Parameters<typeof originalReadFileSync>[1]) => {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath) : filePath
    if (
      resolved === path.resolve(root, 'metadata.jsonl') ||
      resolved === path.resolve(root, 'rejected.jsonl')
    ) {
      throw new Error('manifest summary must not use fs.readFileSync')
    }
    return originalReadFileSync(filePath as never, options as never)
  }) as typeof fs.readFileSync

  const summary = getStorageSummary(root)
  const items = new Map(summary.items.map((item) => [item.target, item]))

  assert.equal(items.get('metadata')?.recordCount, 2)
  assert.equal(items.get('rejected_manifest')?.recordCount, 2)
})

test('getStorageSummary warns when manifest target exists but is not a regular file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-manifest-dir-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(root, 'metadata.jsonl'), { recursive: true })
  fs.writeFileSync(path.join(root, 'rejected.jsonl'), '{"reason":"clean"}\n')

  const summary = getStorageSummary(root)
  const items = new Map(summary.items.map((item) => [item.target, item]))
  const metadata = items.get('metadata')

  assert.equal(metadata?.exists, true)
  assert.equal(metadata?.fileCount, 0)
  assert.equal(metadata?.recordCount, 0)
  assert.equal((metadata?.warnings.length ?? 0) > 0, true)
  assert.equal(metadata?.warnings.some((warning) => warning.includes('not a regular file')), true)
})

test('getStorageSummary reads large manifests in multiple readSync chunks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-large-manifest-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  const originalReadSync = fs.readSync
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    fs.readSync = originalReadSync
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const metadataPath = path.resolve(root, 'metadata.jsonl')
  const largeLines = Array.from({ length: 6000 }, (_, index) => `{"saved_path":"img-${index}.png"}`)
  fs.writeFileSync(metadataPath, `${largeLines.join('\n')}\n`)
  fs.writeFileSync(path.join(root, 'rejected.jsonl'), '{"reason":"clean"}\n')

  const readRequests: number[] = []
  fs.readSync = ((
    fd: number,
    buffer: Buffer,
    offsetOrOptions?: number | (fs.ObjectEncodingOptions & { offset?: number; length?: number; position?: number | bigint | null }),
    length?: number,
    position?: number | bigint | null,
  ) => {
    const requestedLength =
      typeof offsetOrOptions === 'number'
        ? (length ?? buffer.byteLength)
        : (offsetOrOptions?.length ?? buffer.byteLength)
    readRequests.push(requestedLength)
    return originalReadSync(fd, buffer, offsetOrOptions as never, length as never, position as never)
  }) as typeof fs.readSync

  const summary = getStorageSummary(root)
  const items = new Map(summary.items.map((item) => [item.target, item]))

  assert.equal(items.get('metadata')?.recordCount, largeLines.length)
  assert.equal(readRequests.length > 1, true)
  assert.equal(readRequests.every((size) => size <= 64 * 1024), true)
})

test('getStorageSummary does not count truncated or invalid JSON tail lines in manifests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-invalid-tail-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.writeFileSync(path.join(root, 'metadata.jsonl'), ['{"saved_path":"a.png"}', '{"saved_path":', ''].join('\n'))
  fs.writeFileSync(path.join(root, 'rejected.jsonl'), ['{"reason":"clean"}', 'not-json', ''].join('\n'))

  const summary = getStorageSummary(root)
  const items = new Map(summary.items.map((item) => [item.target, item]))

  assert.equal(items.get('metadata')?.recordCount, 1)
  assert.equal(items.get('rejected_manifest')?.recordCount, 1)
})

test('getStorageSummary skips transient file errors and reports warnings instead of failing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-warnings-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  const originalStatSync = fs.statSync
  const mutableFs = fs as typeof fs & { statSync: typeof fs.statSync }
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    mutableFs.statSync = originalStatSync
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const originalDir = path.join(root, '_pipeline_stages', 'original', 'front')
  const birefnetDir = path.join(root, '_pipeline_stages', 'birefnet', 'front')
  fs.mkdirSync(originalDir, { recursive: true })
  fs.mkdirSync(birefnetDir, { recursive: true })
  fs.writeFileSync(path.join(originalDir, 'ok.jpg'), Buffer.from('ok'))
  const flakyFile = path.join(birefnetDir, 'missing.png')
  fs.writeFileSync(flakyFile, Buffer.from('tmp'))

  mutableFs.statSync = ((targetPath: fs.PathLike, options?: fs.StatOptions & { bigint?: boolean }) => {
    const resolved = path.resolve(String(targetPath))
    if (resolved === path.resolve(flakyFile)) {
      const error = new Error('file disappeared') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return originalStatSync(targetPath, options as never)
  }) as typeof fs.statSync

  const summary = getStorageSummary(root)
  const items = new Map(summary.items.map((item) => [item.target, item]))
  const birefnet = items.get('stage_birefnet')

  assert.equal(items.get('stage_original')?.fileCount, 1)
  assert.equal(birefnet?.fileCount, 0)
  assert.equal(Array.isArray(birefnet?.warnings), true)
  assert.equal((birefnet?.warnings.length ?? 0) > 0, true)
  assert.equal(birefnet?.warnings.some((warning) => warning.includes('ENOENT')), true)
})

test('getStorageItems groups rejected stage images by view and reason', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-detail-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const rejectedRoot = path.join(root, '_pipeline_stages', 'rejected')
  const first = path.join(rejectedRoot, 'front', 'clean_rejected', 'a.png')
  const second = path.join(rejectedRoot, 'front', 'clean_rejected', 'b.png')
  const third = path.join(rejectedRoot, 'rear', 'duplicate', 'c.png')
  for (const filePath of [first, second, third]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(path.basename(filePath)))
  }

  const detail = getStorageItems(root, 'stage_rejected')
  const groups = new Map(detail.groups.map((group) => [group.key, group]))

  assert.equal(detail.target, 'stage_rejected')
  assert.equal(detail.summary.target, 'stage_rejected')
  assert.equal(groups.get('front/clean_rejected')?.fileCount, 2)
  assert.equal(groups.get('rear/duplicate')?.fileCount, 1)
  assert.equal(
    detail.samples.some((sample) => sample.path === '_pipeline_stages/rejected/front/clean_rejected/a.png'),
    true,
  )
})

test('planStorageAction marks accepted delete as high risk and requires typed confirmation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-plan-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const acceptedDir = path.join(root, '_pipeline_stages', 'accepted', 'front')
  fs.mkdirSync(acceptedDir, { recursive: true })
  fs.writeFileSync(path.join(acceptedDir, 'accepted-a.png'), Buffer.from('accepted-a'))
  fs.writeFileSync(path.join(acceptedDir, 'accepted-b.png'), Buffer.from('accepted-b'))

  const plan = planStorageAction(root, {
    target: 'stage_accepted',
    action: 'delete',
  })

  assert.equal(plan.target, 'stage_accepted')
  assert.equal(plan.action, 'delete')
  assert.equal(plan.risk, 'high')
  assert.equal(plan.fileCount, 2)
  assert.equal(plan.requiresTypedConfirmation, true)
  assert.equal(plan.confirmationText, 'DELETE_ACCEPTED')
  assert.equal(plan.samplePaths.length > 0, true)
  assert.equal(plan.samplePaths.every((samplePath) => samplePath.startsWith('_pipeline_stages/accepted/')), true)
})

test('planStorageAction rejects illegal actions for manifest targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-manifest-plan-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.writeFileSync(path.join(root, 'metadata.jsonl'), '{"saved_path":"accepted/a.png"}\n')

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'metadata',
        action: 'delete',
      }),
    /metadata.*delete|delete.*metadata|not allowed|unsupported/i,
  )
  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'metadata',
        action: 'cleanup',
      }),
    /metadata.*cleanup|cleanup.*metadata|not allowed|unsupported/i,
  )
})

test('planStorageAction rejects forged groupKey values that are not exact visible groups', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-groupkey-forged-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const filePath = path.join(root, '_pipeline_stages', 'rejected', 'front', 'clean_rejected', 'a.png')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.from('a'))

  const detail = getStorageItems(root, 'stage_rejected')
  assert.deepEqual(
    detail.groups.map((group) => group.key),
    ['front/clean_rejected'],
  )

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'stage_rejected',
        action: 'delete',
        groupKey: 'front/clean_rejected/../clean_rejected',
      }),
    /groupKey|visible group|invalid|group-scoped action/i,
  )
})

test('planStorageAction rejects blank or unknown groupKey values', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-groupkey-invalid-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const filePath = path.join(root, '_pipeline_stages', 'accepted', 'front', 'a.png')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.from('a'))

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'stage_accepted',
        action: 'delete',
        groupKey: '   ',
      }),
    /groupKey|blank|visible group|invalid/i,
  )
  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'stage_accepted',
        action: 'delete',
        groupKey: 'rear',
      }),
    /groupKey|visible group|invalid|group-scoped action/i,
  )
})

test('planStorageAction rejects backup for directory targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-backup-directory-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const acceptedFile = path.join(root, '_pipeline_stages', 'accepted', 'front', 'a.png')
  fs.mkdirSync(path.dirname(acceptedFile), { recursive: true })
  fs.writeFileSync(acceptedFile, Buffer.from('a'))

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'stage_accepted',
        action: 'backup',
      }),
    /stage_accepted.*backup|backup.*stage_accepted|not allowed|unsupported/i,
  )
})

test('planStorageAction allows backup for manifest targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-backup-manifest-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.writeFileSync(path.join(root, 'metadata.jsonl'), '{"saved_path":"accepted/a.png"}\n')

  const plan = planStorageAction(root, {
    target: 'metadata',
    action: 'backup',
  })

  assert.equal(plan.target, 'metadata')
  assert.equal(plan.action, 'backup')
  assert.equal(plan.fileCount, 1)
  assert.equal(plan.risk, 'low')
})

test('planStorageAction allows cleanup for stage_rejected and review_rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-cleanup-rejected-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const stageRejectedFile = path.join(root, '_pipeline_stages', 'rejected', 'front', 'clean_rejected', 'a.png')
  const reviewRejectedFile = path.join(root, '_review', 'rejected', 'preview.jpg')
  fs.mkdirSync(path.dirname(stageRejectedFile), { recursive: true })
  fs.mkdirSync(path.dirname(reviewRejectedFile), { recursive: true })
  fs.writeFileSync(stageRejectedFile, Buffer.from('a'))
  fs.writeFileSync(reviewRejectedFile, Buffer.from('preview'))

  const stagePlan = planStorageAction(root, {
    target: 'stage_rejected',
    action: 'cleanup',
  })
  const reviewPlan = planStorageAction(root, {
    target: 'review_rejected',
    action: 'cleanup',
  })

  assert.equal(stagePlan.action, 'cleanup')
  assert.equal(stagePlan.target, 'stage_rejected')
  assert.equal(stagePlan.fileCount, 1)
  assert.equal(reviewPlan.action, 'cleanup')
  assert.equal(reviewPlan.target, 'review_rejected')
  assert.equal(reviewPlan.fileCount, 1)
})

test('planStorageAction rejects destructive grouped deletes and only allows grouped cleanup for stage_rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-grouped-destructive-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const acceptedFile = path.join(root, '_pipeline_stages', 'accepted', 'front', 'accepted.png')
  const rejectedFile = path.join(root, '_pipeline_stages', 'rejected', 'front', 'clean_rejected', 'rejected.png')
  fs.mkdirSync(path.dirname(acceptedFile), { recursive: true })
  fs.mkdirSync(path.dirname(rejectedFile), { recursive: true })
  fs.writeFileSync(acceptedFile, Buffer.from('accepted'))
  fs.writeFileSync(rejectedFile, Buffer.from('rejected'))

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'stage_accepted',
        action: 'delete',
        groupKey: 'front',
      }),
    /group|delete|not allowed|unsupported/i,
  )

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'stage_rejected',
        action: 'delete',
        groupKey: 'front/clean_rejected',
      }),
    /group|delete|not allowed|unsupported/i,
  )

  const cleanupPlan = planStorageAction(root, {
    target: 'stage_rejected',
    action: 'cleanup',
    groupKey: 'front/clean_rejected',
  })

  assert.equal(cleanupPlan.target, 'stage_rejected')
  assert.equal(cleanupPlan.action, 'cleanup')
  assert.equal(cleanupPlan.fileCount, 1)
})

test('planStorageAction rejects delete for review_rejected because only cleanup is supported', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-review-delete-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const previewFile = path.join(root, '_review', 'rejected', 'preview.jpg')
  fs.mkdirSync(path.dirname(previewFile), { recursive: true })
  fs.writeFileSync(previewFile, Buffer.from('preview'))

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'review_rejected',
        action: 'delete',
      }),
    /review_rejected.*delete|delete.*review_rejected|not allowed|unsupported/i,
  )
})

test('planStorageAction rejects refresh because refresh stays synchronous', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-refresh-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(root, '_pipeline_stages', 'original', 'front'), { recursive: true })
  fs.writeFileSync(path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg'), Buffer.from('a'))

  assert.throws(
    () =>
      planStorageAction(root, {
        target: 'stage_original',
        action: 'refresh',
      } as never),
    /refresh.*not allowed|not allowed.*refresh|unsupported/i,
  )
})

test('executeStorageAction removes part files through a background job', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-execute-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(root, '_pipeline_stages', 'original', 'front'), { recursive: true })
  const tempFile = path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg.part')
  fs.writeFileSync(tempFile, Buffer.from('part'))

  const plan = planStorageAction(root, { target: 'stage_part_files', action: 'cleanup' })
  const job = executeStorageAction(root, {
    planToken: plan.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for storage job')), 2000)
    const unsub = subscribeStorageJob(job.id, (line) => {
      if (!line.includes('job finished')) return
      clearTimeout(timer)
      unsub?.()
      resolve()
    }, root)
  })

  assert.equal(fs.existsSync(tempFile), false)
  assert.equal(getStorageJob(job.id, root)?.status, 'exited')
})

test('executeStorageAction returns before batched work finishes and completes later', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-async-execute-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  const originalRmSync = fs.rmSync
  const originalPromisesRm = fs.promises.rm
  const mutableFs = fs as typeof fs & { rmSync: typeof fs.rmSync }
  const mutablePromises = fs.promises as typeof fs.promises & { rm: typeof fs.promises.rm }
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    mutableFs.rmSync = originalRmSync
    mutablePromises.rm = originalPromisesRm
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const parts = Array.from({ length: 12 }, (_, index) =>
    path.join(root, '_pipeline_stages', 'original', 'front', `file-${index}.jpg.part`),
  )
  for (const filePath of parts) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(path.basename(filePath)))
  }

  mutableFs.rmSync = ((targetPath: fs.PathLike, options?: fs.RmOptions) => {
    const deadline = Date.now() + 10
    while (Date.now() < deadline) {
      // busy wait to simulate slow synchronous deletion
    }
    return originalRmSync(targetPath, options)
  }) as typeof fs.rmSync

  mutablePromises.rm = (async (targetPath: fs.PathLike, options?: fs.RmOptions) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return originalPromisesRm(targetPath, options)
  }) as typeof fs.promises.rm

  const plan = planStorageAction(root, { target: 'stage_part_files', action: 'cleanup' })
  const job = executeStorageAction(root, {
    planToken: plan.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })

  assert.equal(job.status, 'running')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(getStorageJob(job.id, root)?.status, 'running')
  assert.equal(parts.some((filePath) => fs.existsSync(filePath)), true)

  await waitForStorageJobTerminal(job.id, root, 10000)
  assert.equal(getStorageJob(job.id, root)?.status, 'exited')
  assert.equal(parts.every((filePath) => !fs.existsSync(filePath)), true)
})

test('executeStorageAction rejects expired plans', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-expired-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  const previousPlanTtl = process.env.CRAWLER_STORAGE_PLAN_TTL_MS
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root
  process.env.CRAWLER_STORAGE_PLAN_TTL_MS = '10'

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    if (previousPlanTtl === undefined) delete process.env.CRAWLER_STORAGE_PLAN_TTL_MS
    else process.env.CRAWLER_STORAGE_PLAN_TTL_MS = previousPlanTtl
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(root, '_pipeline_stages', 'original', 'front'), { recursive: true })
  fs.writeFileSync(path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg.part'), Buffer.from('a'))

  const plan = planStorageAction(root, { target: 'stage_part_files', action: 'cleanup' })
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.throws(
    () =>
      executeStorageAction(root, {
        planToken: plan.planToken,
        target: 'stage_part_files',
        action: 'cleanup',
      }),
    /expired/i,
  )
})

test('storage jobs SSE sends terminal status and closes for completed jobs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-sse-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(root, '_pipeline_stages', 'original', 'front'), { recursive: true })
  fs.writeFileSync(path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg.part'), Buffer.from('part'))

  const plan = planStorageAction(root, { target: 'stage_part_files', action: 'cleanup' })
  const job = executeStorageAction(root, {
    planToken: plan.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })
  await waitForStorageJobTerminal(job.id, root, 10000)

  const server = app.listen(0)
  t.after(() => {
    server.close()
  })

  const address = server.address() as AddressInfo | null
  assert.ok(address, 'expected test server address')
  const query = new URLSearchParams({ out: root })
  const response = await fetch(`http://127.0.0.1:${address.port}/api/crawl/storage/jobs/${job.id}/stream?${query.toString()}`)
  assert.equal(response.status, 200)

  const body = await readResponseBodyUntilClose(response, 800)
  assert.match(body, /event: init/)
  assert.match(body, /event: done/)
  assert.match(body, /"status":"exited"/)
})

test('listStorageJobs filters by output root and omits full log lines', async (t) => {
  const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-list-'))
  const rootA = path.join(baseRoot, 'out-a')
  const rootB = path.join(baseRoot, 'out-b')
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = baseRoot
  process.env.DATASET_ROOT = baseRoot

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(baseRoot, { recursive: true, force: true })
  })

  const partA = path.join(rootA, '_pipeline_stages', 'original', 'front', 'a.jpg.part')
  const partB = path.join(rootB, '_pipeline_stages', 'original', 'front', 'b.jpg.part')
  fs.mkdirSync(path.dirname(partA), { recursive: true })
  fs.mkdirSync(path.dirname(partB), { recursive: true })
  fs.writeFileSync(partA, Buffer.from('a'))
  fs.writeFileSync(partB, Buffer.from('b'))

  const planA = planStorageAction(rootA, { target: 'stage_part_files', action: 'cleanup' })
  const planB = planStorageAction(rootB, { target: 'stage_part_files', action: 'cleanup' })
  const jobA = executeStorageAction(rootA, {
    planToken: planA.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })
  executeStorageAction(rootB, {
    planToken: planB.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })

  await waitForStorageJobTerminal(jobA.id, rootA, 10000)

  const listing = listStorageJobs(rootA as never)
  assert.equal(listing.items.length, 1)
  assert.equal(listing.items[0]?.id, jobA.id)
  assert.equal('lines' in (listing.items[0] as object), false)
})

test('listStorageJobs requires an explicit output root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-list-required-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const tempFile = path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg.part')
  fs.mkdirSync(path.dirname(tempFile), { recursive: true })
  fs.writeFileSync(tempFile, Buffer.from('a'))

  const plan = planStorageAction(root, { target: 'stage_part_files', action: 'cleanup' })
  const job = executeStorageAction(root, {
    planToken: plan.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })
  assert.throws(() => listStorageJobs(undefined), /out.*required|required.*out/i)
})

test('storage jobs SSE rejects requests for a different output root', async (t) => {
  const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-stream-'))
  const rootA = path.join(baseRoot, 'out-a')
  const rootB = path.join(baseRoot, 'out-b')
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = baseRoot
  process.env.DATASET_ROOT = baseRoot

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(baseRoot, { recursive: true, force: true })
  })

  const partA = path.join(rootA, '_pipeline_stages', 'original', 'front', 'a.jpg.part')
  fs.mkdirSync(path.dirname(partA), { recursive: true })
  fs.writeFileSync(partA, Buffer.from('a'))

  const plan = planStorageAction(rootA, { target: 'stage_part_files', action: 'cleanup' })
  const job = executeStorageAction(rootA, {
    planToken: plan.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })
  await waitForStorageJobTerminal(job.id, rootA, 10000)

  const server = app.listen(0)
  t.after(() => {
    server.close()
  })

  const address = server.address() as AddressInfo | null
  assert.ok(address, 'expected test server address')
  const query = new URLSearchParams({ out: rootB })
  const response = await fetch(`http://127.0.0.1:${address.port}/api/crawl/storage/jobs/${job.id}/stream?${query.toString()}`)
  assert.equal(response.status, 404)
})

test('storage jobs list rejects requests without out', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-list-route-required-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const tempFile = path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg.part')
  fs.mkdirSync(path.dirname(tempFile), { recursive: true })
  fs.writeFileSync(tempFile, Buffer.from('a'))

  const plan = planStorageAction(root, { target: 'stage_part_files', action: 'cleanup' })
  const job = executeStorageAction(root, {
    planToken: plan.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })
  const server = app.listen(0)
  t.after(() => {
    server.close()
  })

  const address = server.address() as AddressInfo | null
  assert.ok(address, 'expected test server address')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/crawl/storage/jobs`)
  assert.equal(response.status, 400)
  assert.match(await response.text(), /out.*required|required.*out/i)
})

test('storage jobs SSE rejects requests without out', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-storage-stream-required-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root

  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const tempFile = path.join(root, '_pipeline_stages', 'original', 'front', 'a.jpg.part')
  fs.mkdirSync(path.dirname(tempFile), { recursive: true })
  fs.writeFileSync(tempFile, Buffer.from('a'))

  const plan = planStorageAction(root, { target: 'stage_part_files', action: 'cleanup' })
  const job = executeStorageAction(root, {
    planToken: plan.planToken,
    target: 'stage_part_files',
    action: 'cleanup',
  })
  const server = app.listen(0)
  t.after(() => {
    server.close()
  })

  const address = server.address() as AddressInfo | null
  assert.ok(address, 'expected test server address')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/crawl/storage/jobs/${job.id}/stream`)
  assert.equal(response.status, 400)
  assert.match(await response.text(), /out.*required|required.*out/i)
})

test('rejected previews prefer decision and birefnet artifacts over legacy JPEG files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-preview-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root
  t.after(() => {
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const decisionPath = path.join(root, '_pipeline_stages', 'rejected', 'front', 'clean_rejected', 'sample.png')
  const birefnetPath = path.join(root, '_pipeline_stages', 'birefnet', 'front', 'sample.png')
  const legacyPath = path.join(root, '_review', 'rejected', 'sample.jpg')
  for (const filePath of [decisionPath, birefnetPath, legacyPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, path.basename(filePath))
  }
  fs.writeFileSync(path.join(root, 'rejected.jsonl'), `${JSON.stringify({
    md5: 'sample',
    preview_path: legacyPath,
    pipeline_artifacts: { decision: decisionPath, birefnet: birefnetPath },
  })}\n`)

  const [preview] = getCrawlPreviews(root, 'rejected', 1).items
  assert.ok(preview)
  assert.equal(getCrawlPreviewSource(root, 'rejected', preview.id)?.localPath, decisionPath)

  fs.rmSync(decisionPath)
  assert.equal(getCrawlPreviewSource(root, 'rejected', preview.id)?.localPath, birefnetPath)

  fs.rmSync(birefnetPath)
  assert.equal(getCrawlPreviewSource(root, 'rejected', preview.id)?.localPath, legacyPath)
})

test('preview image lookups reuse records cached by the preview list', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-preview-cache-'))
  const previousProjectRoot = process.env.CRAWLER_PROJECT_ROOT
  const previousDatasetRoot = process.env.DATASET_ROOT
  const originalReadSync = fs.readSync
  process.env.CRAWLER_PROJECT_ROOT = root
  process.env.DATASET_ROOT = root
  t.after(() => {
    fs.readSync = originalReadSync
    if (previousProjectRoot === undefined) delete process.env.CRAWLER_PROJECT_ROOT
    else process.env.CRAWLER_PROJECT_ROOT = previousProjectRoot
    if (previousDatasetRoot === undefined) delete process.env.DATASET_ROOT
    else process.env.DATASET_ROOT = previousDatasetRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  const records = Array.from({ length: 8 }, (_, index) => {
    const savedPath = path.join(root, `preview-${index}.png`)
    fs.writeFileSync(savedPath, `preview-${index}`)
    return { md5: `preview-${index}`, saved_path: savedPath }
  })
  fs.writeFileSync(path.join(root, 'metadata.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

  let readCount = 0
  fs.readSync = ((
    fd: number,
    buffer: Buffer,
    offsetOrOptions?: number | (fs.ObjectEncodingOptions & { offset?: number; length?: number; position?: number | bigint | null }),
    length?: number,
    position?: number | bigint | null,
  ) => {
    readCount += 1
    return originalReadSync(fd, buffer, offsetOrOptions as never, length as never, position as never)
  }) as typeof fs.readSync

  const previews = getCrawlPreviews(root, 'accepted', 8).items
  assert.equal(previews.length, 8)
  assert.equal(readCount, 1)

  for (const preview of previews) {
    assert.ok(getCrawlPreviewSource(root, 'accepted', preview.id)?.localPath)
  }
  assert.equal(readCount, 1)
})
