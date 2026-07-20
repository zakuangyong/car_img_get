# 爬取控制台：阶段目录管理设计

## 背景与目标

当前爬取控制台已经支持：
- 启动和停止采集清洗任务
- 通过 SSE 查看实时日志
- 查看最近落库与拒绝样本预览
- 读取 `metadata.jsonl` 与 `rejected.jsonl` 生成预览

但对于采集流程产生的目录和清单文件，当前仅支持被动读取，不支持可视化管理。尤其是以下对象缺少统一入口：
- `_pipeline_stages/original`
- `_pipeline_stages/birefnet`
- `_pipeline_stages/accepted`
- `_pipeline_stages/rejected`
- `_review/rejected`
- `metadata.jsonl`
- `rejected.jsonl`

本设计在现有“爬取控制台”内新增“目录管理”能力，用于浏览、统计、导出、清理和删除上述目录与文件。

目标：
- 在现有 `Crawler` 页面内新增独立的“目录管理”工作区
- 统一展示阶段目录和清单文件的数量、体积、更新时间与异常状态
- 支持受控的导出、清理、删除、备份操作
- 所有破坏性操作都具备预估、确认、日志和安全限制

非目标：
- 不实现任意路径文件管理器
- 不支持在线编辑 `metadata.jsonl` 或 `rejected.jsonl`
- 不管理正式落库目录 `series_xxx/spec_xxx/.../view_xxx/*.png`
- 不支持跨项目根目录或数据根目录的任意导出/删除

## 设计结论

采用方案 2：在现有爬取控制台中保留现有监控能力，同时新增一个独立的“目录管理”标签页。

推荐原因：
- 与当前工作流连续，用户无需跳到新页面
- 运行监控与目录治理属于同一业务域，但可通过标签页隔离认知负担
- 便于复用当前任务列表、日志流和状态展示模式

## 页面结构

`Crawler` 页面保留当前主布局，但右侧工作区拆分为两个标签：
- `运行监控`
- `目录管理`

### 运行监控

保留现有功能：
- 任务状态
- 最近落库 / 拒绝预览
- 最近任务
- 任务日志

### 目录管理

新增一个完整的管理面板，内部拆分为 4 个区块：

1. 总览卡片
- 展示每个受管目标的数量、体积、最近更新时间、异常数
- 额外展示 `.part` 残留数、拒绝原因总数等摘要指标

2. 目录明细表
- 每行代表一个受管目标
- 列包括：名称、类型、数量、体积、最近更新时间、状态、操作
- 操作包括：查看、导出、刷新统计、清理、删除、备份

3. 内容预览区
- 目录：展示最近文件、代表样本、按 `view` 或 `reason` 的聚合分布
- `metadata.jsonl` / `rejected.jsonl`：展示记录数、尾部记录、字段摘要

4. 危险操作区
- 单独集中所有破坏性动作
- 避免在列表中到处散落删除按钮
- 所有危险操作都先经过预估，再进入确认执行

## 受管目标与标识

前后端不直接传任意物理路径，而使用固定 target id：
- `stage_original`
- `stage_birefnet`
- `stage_accepted`
- `stage_rejected`
- `review_rejected`
- `metadata`
- `rejected_manifest`
- `stage_part_files`

映射关系：
- `stage_original` -> `_pipeline_stages/original`
- `stage_birefnet` -> `_pipeline_stages/birefnet`
- `stage_accepted` -> `_pipeline_stages/accepted`
- `stage_rejected` -> `_pipeline_stages/rejected`
- `review_rejected` -> `_review/rejected`
- `metadata` -> `metadata.jsonl`
- `rejected_manifest` -> `rejected.jsonl`
- `stage_part_files` -> `_pipeline_stages/**/*.part`

这样可以避免前端直接传路径，降低误删风险，并使权限控制更清晰。

## 目录能力设计

### `_pipeline_stages/original`

支持：
- 统计数量、体积、最近更新时间
- 查看最近样本
- 按视角分组统计
- 导出
- 批量删除

用途：
- 核对原始下载内容
- 判断原始格式是否为 jpg/webp/png 等

### `_pipeline_stages/birefnet`

支持：
- 统计数量、体积、最近更新时间
- 查看最近样本
- 按视角分组统计
- 导出
- 批量删除

用途：
- 验证主体扣图效果

### `_pipeline_stages/accepted`

支持：
- 统计数量、体积、最近更新时间
- 查看最近样本
- 导出
- 批量删除

说明：
- 这是最终决策图镜像，不等于正式落库图
- 但它与通过样本高度相关，因此删除时按高风险处理

### `_pipeline_stages/rejected`

支持：
- 统计数量、体积、最近更新时间
- 按 `view / reason` 聚合
- 查看最近样本
- 导出
- 按原因清理
- 整目录清理

说明：
- 这是最适合精细化治理的目录
- 第一版需要重点做好按拒绝原因的统计与清理

### `_review/rejected`

支持：
- 统计数量、体积、最近更新时间
- 缩略图浏览
- 批量清空
- 导出

说明：
- 该目录用于人工复核，属于低风险清理对象

### `metadata.jsonl`

支持：
- 记录数
- 最后更新时间
- 尾部预览
- 字段摘要
- 导出
- 备份副本

限制：
- 不允许在线编辑
- 第一版不允许页面直接删除文件本体

### `rejected.jsonl`

支持：
- 记录数
- 最后更新时间
- 拒绝原因统计
- 尾部预览
- 字段摘要
- 导出
- 备份副本

限制：
- 不允许在线编辑
- 第一版不允许页面直接删除文件本体

## 管理动作设计

统一动作：
- `查看`
- `导出`
- `刷新统计`
- `清理`
- `删除`
- `备份`

### 查看

目录对象返回：
- 基础统计
- 最近文件列表
- 分组统计
- 代表样本

清单文件返回：
- 记录总数
- 最后更新时间
- 尾部若干条记录
- 关键字段聚合摘要

### 导出

第一版采用“服务端复制到项目内导出目录”的方式：
- 前端选择目标
- 后端在项目内安全目录生成导出副本或打包文件
- 前端提供导出结果路径或下载入口

原因：
- 相比直接流式打包下载更稳，便于处理大目录
- 可复用后台任务与日志机制

### 刷新统计

作用：
- 重新扫描目标对象
- 更新数量、体积、最新时间
- 更新异常计数

### 清理

支持的典型动作：
- 清理 `.part` 残留
- 清空 `_review/rejected`
- 按 `reason` 清理 `_pipeline_stages/rejected`
- 按 `view` 清理 `_pipeline_stages/rejected`

### 删除

支持的典型动作：
- 删除某个阶段目录下全部内容
- 删除 `accepted` 阶段图镜像
- 删除 `original` 或 `birefnet` 阶段目录内容

限制：
- 不允许删除正式落库目录
- 不允许对任意路径执行删除

### 备份

仅针对清单文件：
- `metadata.jsonl`
- `rejected.jsonl`

备份目标建议写入：
- `_management_backups/`

## 后端接口设计

### `GET /api/crawl/storage/summary?out=...`

用途：
- 返回所有受管目标的摘要统计

返回内容：
- target id
- 名称
- 类型
- 数量
- 体积
- 最近更新时间
- 状态
- 异常信息

用于：
- 总览卡片
- 目录明细表

### `GET /api/crawl/storage/items?out=...&target=...`

用途：
- 返回某一个受管目标的详细内容

目录返回：
- 最近文件列表
- 子分组统计
- 代表样本路径

清单文件返回：
- 记录数
- 尾部记录
- 字段摘要
- 对 `rejected.jsonl` 增加 `reason` 聚合

### `POST /api/crawl/storage/plan`

用途：
- 所有导出、清理、删除、备份动作的预估入口

输入：
- `out`
- `target`
- `action`
- 可选筛选参数（如 `reason`、`view`）

返回：
- `planToken`
- 风险等级
- 预计文件数
- 预计体积
- 示例路径
- 影响范围描述
- 是否影响现有预览
- 是否影响历史记录文件

说明：
- 前端不能跳过此接口直接执行删除

### `POST /api/crawl/storage/execute`

用途：
- 真正执行导出、清理、删除、备份

输入：
- `planToken`
- 用户确认信息

返回：
- 后台任务 id

说明：
- 所有重操作都任务化，便于日志追踪和长时间执行

### `GET /api/crawl/storage/jobs`

用途：
- 返回目录管理任务列表

### `GET /api/crawl/storage/jobs/:id/stream`

用途：
- 返回目录管理任务日志流

说明：
- 复用当前爬虫任务的 SSE 模式

## 执行模型

轻量接口同步返回：
- summary
- items
- plan

耗时操作后台任务化：
- 导出
- 批量删除
- 批量清理
- 备份

日志目录建议：
- `run/storage_jobs/`

日志格式沿用现有规范：
- stdout -> `LOG`
- stderr -> `MSG`

单次目录管理任务日志至少包含：
- 时间
- 动作类型
- target id
- 预估数量
- 实际处理数量
- 成功/失败状态

## 风险分级

### 低风险

- 清理 `.part` 残留
- 清空 `_review/rejected`
- 导出目录内容
- 备份 `metadata.jsonl` / `rejected.jsonl`

### 中风险

- 删除 `_pipeline_stages/rejected`
- 按 `reason/view` 清理 rejected 阶段图
- 删除 `_pipeline_stages/birefnet`
- 删除 `_pipeline_stages/original`

### 高风险

- 删除 `_pipeline_stages/accepted`
- 清空全部 `_pipeline_stages`
- 删除 `metadata.jsonl` / `rejected.jsonl` 文件本体

说明：
- 第一版 UI 不暴露删除 `metadata.jsonl` / `rejected.jsonl` 文件本体的入口，仅保留备份能力

## 确认与保护机制

所有破坏性操作都必须经过两步：
1. `plan`
2. `confirm + execute`

### 默认确认

确认面板展示：
- 目标对象
- 动作类型
- 预计文件数
- 预计体积
- 示例路径
- 风险等级
- 是否影响当前预览
- 是否影响历史清单
- 是否可恢复

### 高风险二次确认

高风险动作要求用户输入确认文本：
- 删除 `accepted` 阶段图时输入 `DELETE_ACCEPTED`
- 清空全部阶段目录时输入 `DELETE_ALL_STAGES`

说明：
- 避免简单误触造成不可逆损失

## 与现有预览能力的联动

现有“最近落库 / 最近拒绝”预览继续保留，但需要与目录管理动作联动刷新。

### 删除 `_review/rejected`

影响：
- 拒绝预览本地缩略图失效

回退策略：
- 若允许，则回退到远程原图
- 若无远程可用图，则显示无图状态

### 删除 `_pipeline_stages/rejected`

影响：
- `rejected.jsonl` 仍保留记录
- 阶段图预览失效

UI 提示：
- 明确显示“记录存在，阶段图已清理”

### 删除 `_pipeline_stages/accepted`

影响：
- accepted 阶段镜像失效

回退策略：
- 已落库预览优先使用正式 `saved_path`
- 不依赖 accepted 阶段镜像

该设计与当前后端逻辑兼容，因为当前 accepted 预览本来就优先读取正式落库图。

## 前端状态与交互设计

### 目录管理标签页状态

建议状态：
- `storageSummary`
- `storageSelectedTarget`
- `storageDetail`
- `storagePlan`
- `storageJob`
- `storageError`

### 典型交互流程

1. 用户进入“目录管理”
2. 前端请求 `summary`
3. 用户点击某个目标的“查看”或“清理”
4. 若是查看，前端请求 `items`
5. 若是破坏性动作，先请求 `plan`
6. 用户在确认面板确认
7. 前端请求 `execute`
8. 页面显示后台任务日志
9. 完成后自动刷新 `summary`、`items` 和预览区

## 安全约束

- 所有 `out` 路径都必须解析到项目根目录或数据根目录内
- target id 到物理路径的映射必须由后端固定定义
- 不允许前端传入任意删除路径
- 删除与导出都必须基于受控 target id
- 正式落库目录不纳入可删除范围

## 验收标准

- `Crawler` 页面中新增“目录管理”标签页
- 页面可展示各阶段目录和两个 jsonl 文件的数量、体积、更新时间
- 可查看 rejected 的 `reason/view` 聚合统计
- 可清理 `.part` 残留和 `_review/rejected`
- 可按 target 执行导出或删除，并具备任务日志
- 所有删除动作都先返回预估结果，再进行确认执行
- 高风险动作必须额外输入确认文本
- 删除阶段目录后，现有预览区自动刷新并给出合理回退或提示
