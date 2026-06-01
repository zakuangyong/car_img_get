# Web-UI：下载选中图片（ZIP）设计

## 背景与目标

当前 Web-UI 支持基于数据集元信息进行筛选、分页浏览与单张查看，但缺少批量下载能力。本设计新增“下载选中图片”为 ZIP 的能力，便于快速导出样本。

目标：
- 在图片列表页支持多选（跨分页保留）
- 一键下载选中图片为 ZIP
- ZIP 内为扁平结构，文件名为“车型+序号”

非目标：
- 不生成附带清单文件（jsonl/csv）
- 不提供逐张下载模式
- 不改变数据集组织结构与现有静态 `/images/*` 访问

## 用户交互与行为

入口：图片列表页（Home）
- 每个图片卡片新增 checkbox 用于选中/取消选中
- 顶部工具区新增：
  - 已选数量展示
  - 全选本页
  - 清空选中
  - 下载选中（ZIP）

选中集合规则：
- 跨分页保留选中
- 当筛选条件（品牌/车型/年份）发生变化时自动清空选中

下载规则：
- 点击“下载选中”后，前端向后端提交选中 ids，浏览器下载一个 zip 文件
- 当选中为空时按钮置灰或提示不可下载

## ZIP 内容与命名规则

ZIP 文件内容：
- 仅包含图片文件，扁平化放置于 zip 根目录

ZIP 内文件命名：
- 格式：`{model}_{seq}{ext}`
  - `model`：优先使用元信息字段 `model`；为空时回退到 `brand`；仍为空则为 `unknown`
  - `seq`：4 位序号，从 0001 开始；按 `model` 分组分别计数
  - `ext`：从源文件 `filePath` 取扩展名（例如 `.png`）
- 示例：
  - `迈腾_0001.png`
  - `迈腾_0002.png`
  - `雅阁_0001.png`

ZIP 文件名：
- 格式：`selected_{yyyyMMdd_HHmmss}.zip`

## 前端改动设计

文件范围：
- `web_ui/src/pages/Home.tsx`：新增多选 UI、批量操作入口、与选中状态联动
- `web_ui/src/lib/api.ts`：新增下载接口封装（返回 blob 并触发保存）
- 新增一个选中状态 store（使用已安装的 zustand），用于跨分页保留选中

状态设计（建议）：
- `selectedIds: Set<string>`（或序列化为 `string[]` 存储）
- actions：`toggle(id)`、`addMany(ids)`、`removeMany(ids)`、`clear()`

下载实现要点：
- `fetch` 下载接口得到 `blob`
- 使用 `URL.createObjectURL(blob)` + `<a download>` 触发保存
- 下载中禁用按钮并展示加载态（避免重复请求）

## 后端改动设计（Express）

新增路由：
- `POST /api/download`
  - request body：`{ ids: string[] }`
  - response：`application/zip`（流式）

处理流程：
1. 校验 ids（数组、长度限制、去重）
2. 读取数据集索引 `getDatasetIndex()`，通过 `byId` 找到每个 id 的 `filePath` 与 `model/brand`
3. 将 `filePath` 拼接到 `datasetRoot` 得到绝对路径，并做路径安全校验，确保不会逃逸 `datasetRoot`
4. 以流式方式生成 zip 并写入 response
5. response headers：
   - `Content-Type: application/zip`
   - `Content-Disposition: attachment; filename="selected_yyyyMMdd_HHmmss.zip"`

路径安全约束：
- 仅允许访问 `datasetRoot` 内的文件
- 拒绝不存在的 id、缺失 filePath、或解析后不在 datasetRoot 下的路径

失败处理：
- 请求参数错误：400 + JSON 错误信息
- ids 全部无效：400（或 404）+ JSON 错误信息
- 打包过程中读文件失败：优先整体失败（500）；可选实现为跳过并记录（本次不做）

依赖：
- 需引入一个 zip 打包库（例如 archiver/yazl），使用流式输出，避免大内存占用

## 兼容性与限制

- 选中数量过大可能导致下载耗时；后端应设置 ids 数量上限（默认建议 5000，可在实现阶段确定）
- ZIP 打包与传输是流式的，但会占用一定 CPU 与磁盘 IO

## 验收标准

- 列表页可勾选多张图片，翻页后勾选仍保留
- 切换品牌/车型/年份任一筛选项时，选中自动清空
- 点击“下载选中”下载到 zip，zip 内只包含图片，且为扁平结构
- zip 内文件名符合“车型+序号”规则，且同车型序号连续从 0001 开始

