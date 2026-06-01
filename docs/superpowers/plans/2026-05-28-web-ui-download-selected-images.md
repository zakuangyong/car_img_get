# Web-UI Download Selected Images (ZIP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在图片列表页支持跨分页多选，并通过后端接口将选中图片打包为 ZIP 下载（扁平化，车型+序号命名）。

**Architecture:** 前端维护全局选中集合（zustand），列表页提供勾选与批量操作；后端新增 `POST /api/download` 接口，按 ids 解析文件路径并流式生成 zip 输出到响应。

**Tech Stack:** React + react-router-dom + Vite + Tailwind；Express；TypeScript；zip 库（建议 archiver）。

---

## Files & Responsibilities

- Create: `web_ui/src/stores/selection.ts` — 选中集合 store（zustand）
- Modify: `web_ui/src/pages/Home.tsx` — 图片卡片勾选、多选工具栏、筛选变更清空、调用下载
- Modify: `web_ui/src/lib/api.ts` — 下载接口：`downloadSelectedZip(ids)`（fetch blob + 触发保存）
- Modify: `web_ui/api/services/dataset.ts` — 增加安全的 `resolveImageAbsPath` 与文件名生成所需的规范化工具
- Modify: `web_ui/api/routes/dataset.ts` — 增加 `POST /download` 路由，生成 zip 流
- Modify: `web_ui/package.json` — 新增 zip 依赖（archiver）与类型（如需要）

---

### Task 1: Add selection store (zustand)

**Files:**
- Create: `web_ui/src/stores/selection.ts`

- [ ] **Step 1: Create store**

```ts
import { create } from 'zustand'

type SelectionState = {
  selected: Record<string, true>
  toggle: (id: string) => void
  addMany: (ids: string[]) => void
  removeMany: (ids: string[]) => void
  clear: () => void
  count: () => number
  has: (id: string) => boolean
  ids: () => string[]
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selected: {},
  toggle: (id) =>
    set((s) => {
      const next = { ...s.selected }
      if (next[id]) delete next[id]
      else next[id] = true
      return { selected: next }
    }),
  addMany: (ids) =>
    set((s) => {
      const next = { ...s.selected }
      for (const id of ids) next[id] = true
      return { selected: next }
    }),
  removeMany: (ids) =>
    set((s) => {
      const next = { ...s.selected }
      for (const id of ids) delete next[id]
      return { selected: next }
    }),
  clear: () => set({ selected: {} }),
  count: () => Object.keys(get().selected).length,
  has: (id) => Boolean(get().selected[id]),
  ids: () => Object.keys(get().selected),
}))
```

- [ ] **Step 2: Type check**

Run (from `web_ui/`): `npm run check`  
Expected: exit code 0

- [ ] **Step 3: Commit**

```bash
git add web_ui/src/stores/selection.ts
git commit -m "feat(web-ui): add selection store"
```

---

### Task 2: Frontend API for ZIP download

**Files:**
- Modify: `web_ui/src/lib/api.ts`

- [ ] **Step 1: Add helper to POST and get blob**

```ts
async function blobFetch(url: string, init?: RequestInit): Promise<Blob> {
  const r = await fetch(url, init)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${r.status} ${r.statusText}${text ? `: ${text}` : ''}`)
  }
  return await r.blob()
}
```

- [ ] **Step 2: Add download function**

```ts
export async function downloadSelectedZip(ids: string[], filename?: string): Promise<void> {
  const blob = await blobFetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'selected.zip'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}
```

- [ ] **Step 3: Type check**

Run (from `web_ui/`): `npm run check`  
Expected: exit code 0

- [ ] **Step 4: Commit**

```bash
git add web_ui/src/lib/api.ts
git commit -m "feat(web-ui): add download selected zip api"
```

---

### Task 3: Home page UI — checkbox selection + toolbar actions

**Files:**
- Modify: `web_ui/src/pages/Home.tsx`

- [ ] **Step 1: Wire selection store and download api**

Add imports:

```ts
import { downloadSelectedZip } from '@/lib/api'
import { useSelectionStore } from '@/stores/selection'
```

- [ ] **Step 2: Clear selection on filter change**

Add an effect keyed by `brand/model/year`:

```ts
const clearSelection = useSelectionStore((s) => s.clear)
useEffect(() => {
  clearSelection()
}, [brand, model, year, clearSelection])
```

- [ ] **Step 3: Add toolbar actions**

In the result header (paging buttons area), add:
- 已选数量
- 全选本页：`addMany(items.map(x => x.id))`
- 清空：`clear()`
- 下载选中：`downloadSelectedZip(ids, selected_yyyyMMdd_HHmmss.zip)`

Filename generation:

```ts
function formatZipName(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const hh = pad(d.getHours())
  const mm = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  return `selected_${y}${m}${day}_${hh}${mm}${ss}.zip`
}
```

During download:
- local state `downloading` boolean
- disable button when `downloading || selectedCount === 0`

- [ ] **Step 4: Add checkbox overlay per card**

Replace the outer `<Link>` wrapper with a `<div className="group ... relative">` and place:
- A positioned `<Link>` only wrapping the image area (or an overlay link) to keep navigation
- A checkbox element in the top-left corner:

```tsx
<label className="absolute left-2 top-2 z-10 flex items-center gap-2 rounded bg-slate-950/70 px-2 py-1 text-xs">
  <input
    type="checkbox"
    checked={selectedHas(it.id)}
    onChange={() => toggle(it.id)}
    onClick={(e) => e.stopPropagation()}
  />
  选中
</label>
```

Ensure clicking checkbox does not navigate:
- checkbox `onClick` calls `stopPropagation`
- keep `Link` separate from checkbox region

- [ ] **Step 5: Type check**

Run (from `web_ui/`): `npm run check`  
Expected: exit code 0

- [ ] **Step 6: Manual UI verification**

Run (from `web_ui/`): `npm run dev`  
Expected:
- 卡片左上角出现勾选框
- 勾选后“已选 N”变化
- 翻页后选中仍保留
- 改变筛选项后选中清空

- [ ] **Step 7: Commit**

```bash
git add web_ui/src/pages/Home.tsx
git commit -m "feat(web-ui): add checkbox selection and download toolbar"
```

---

### Task 4: Backend — safe path resolve utilities

**Files:**
- Modify: `web_ui/api/services/dataset.ts`

- [ ] **Step 1: Add helpers**

Append exports:

```ts
export function safeJoinUnderRoot(root: string, rel: string): string | null {
  const absRoot = path.resolve(root)
  const abs = path.resolve(absRoot, rel)
  const relToRoot = path.relative(absRoot, abs)
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null
  return abs
}

export function sanitizeZipBaseName(s: string): string {
  const v = String(s ?? '').trim() || 'unknown'
  return v.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'unknown'
}
```

- [ ] **Step 2: Quick type check**

Run (from `web_ui/`): `npm run check`  
Expected: exit code 0

- [ ] **Step 3: Commit**

```bash
git add web_ui/api/services/dataset.ts
git commit -m "feat(api): add safe path and zip name helpers"
```

---

### Task 5: Backend — POST /api/download streaming ZIP

**Files:**
- Modify: `web_ui/api/routes/dataset.ts`
- Modify: `web_ui/package.json`

- [ ] **Step 1: Add dependency**

Install (from `web_ui/`): `npm i archiver`  
If TS complains about types, also: `npm i -D @types/archiver`

- [ ] **Step 2: Implement route**

Add imports:

```ts
import archiver from 'archiver'
import path from 'path'
import { resolveDatasetRoot, safeJoinUnderRoot, sanitizeZipBaseName } from '../services/dataset.js'
```

Add route before `export default router`:

```ts
router.post('/download', async (req, res, next) => {
  try {
    const idsRaw = (req.body as { ids?: unknown })?.ids
    const ids = Array.isArray(idsRaw) ? idsRaw.map((x) => String(x).trim()).filter(Boolean) : []
    const unique = Array.from(new Set(ids))
    if (unique.length === 0) {
      res.status(400).json({ error: 'ids required' })
      return
    }
    if (unique.length > 5000) {
      res.status(400).json({ error: 'too many ids' })
      return
    }

    const idx = await getDatasetIndex()
    const root = resolveDatasetRoot()

    const rows: Array<{ abs: string; model: string; ext: string }> = []
    for (const id of unique) {
      const it = idx.byId.get(id)
      if (!it?.filePath) continue
      const abs = safeJoinUnderRoot(root, it.filePath)
      if (!abs) continue
      const model = sanitizeZipBaseName(String(it.model ?? it.brand ?? 'unknown'))
      const ext = path.extname(it.filePath) || '.png'
      rows.push({ abs, model, ext })
    }

    if (rows.length === 0) {
      res.status(400).json({ error: 'no valid images' })
      return
    }

    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const y = now.getFullYear()
    const m = pad(now.getMonth() + 1)
    const d = pad(now.getDate())
    const hh = pad(now.getHours())
    const mm = pad(now.getMinutes())
    const ss = pad(now.getSeconds())
    const zipName = `selected_${y}${m}${d}_${hh}${mm}${ss}.zip`

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`)

    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', (err) => {
      res.destroy(err as Error)
    })
    archive.pipe(res)

    const counter: Record<string, number> = {}
    for (const r of rows) {
      counter[r.model] = (counter[r.model] ?? 0) + 1
      const seq = String(counter[r.model]).padStart(4, '0')
      const name = `${r.model}_${seq}${r.ext}`
      archive.file(r.abs, { name })
    }

    void archive.finalize()
  } catch (e) {
    next(e)
  }
})
```

- [ ] **Step 3: Type check**

Run (from `web_ui/`): `npm run check`  
Expected: exit code 0

- [ ] **Step 4: Manual verification**

Run (from `web_ui/`): `npm run dev`  
Expected:
- 选中若干张图片点击下载，浏览器得到 zip
- 解压后文件名符合 `{车型}_{0001..}.png`，扁平目录

- [ ] **Step 5: Commit**

```bash
git add web_ui/api/routes/dataset.ts web_ui/package.json web_ui/pnpm-lock.yaml
git commit -m "feat(api): add zip download endpoint for selected images"
```

---

## Plan Self-Review

- Spec coverage:
  - 多选 + 跨页保留：Task 1 + Task 3
  - 筛选变更自动清空：Task 3 Step 2
  - ZIP 扁平化、车型+序号：Task 5 Step 2
  - 不附带清单文件：Task 5 不生成额外条目
- Placeholder scan: 无 TBD/TODO；每步给出代码与命令
- Type consistency: `/api/download` 与 `downloadSelectedZip` 对齐；store API 在 Task 3 使用前已定义

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-web-ui-download-selected-images.md`.

Two execution options:
1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

