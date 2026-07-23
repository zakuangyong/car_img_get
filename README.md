# car\_img\_get

从汽车之家图片库按车系/车型批量拉取图片，并统一转成 PNG，用于构造数据集。

## 安装

```bash
pip install -r requirements.txt
```

## 使用

按车系（seriesid）下载外观图（categoryid=1）并转 PNG：

```bash
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --pagesize 80
```

只要分辨率大于 720×720（宽高都要 >720）：

```bash
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --max 100 --min-size 721
```

限制车型年份范围（从车型版本名 specname 里解析“2020款/2021款…”），例如 2020-2025：

```bash
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --max 100 --min-size 721 --min-year 2020 --max-year 2025
```

按视角做一个粗分类并按目录落盘（需要先安装 `numpy`、`opencv-python`；可选 `ultralytics`，启用内置视角分类模型 `./models/yolo11m-cls-for-car-view-train7.pt`）：

```bash
pip install numpy opencv-python
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --view-scheme front_back_45
```

说明：

- `front_back_45` 会输出 `view_front / view_back / view_side / view_side45`（纯侧面为 side；45 度为 side45）。
- 内置视角模型的 8 个原始类别为：`front / back / left_side / right_side / front_left_side45 / front_right_side45 / back_left_side45 / back_right_side45`。在 `front_back_45` 模式下会自动归并为 `front / back / side / side45` 以便落盘与筛选。
- 可用 `--view-min-conf` 设置视角分类模型的最小置信度阈值（top1conf），低于阈值会回退到启发式规则（保证流程不中断），例如：

```bash
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --view-scheme front_back_45 --view-min-conf 0.6
```

只保留侧向（含侧面45度，粗分类）：

```bash
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --view-scheme front_back_45 --only-view side45
```

只保留纯侧面（右视图，粗分类）：

```bash
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --view-scheme front_back_45 --only-view side
```

全量车系（尽可能大范围）批量下载（建议先用 --max-series / --max-per-series 做试跑，支持断点续跑）：

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --view-scheme front_back_45 --only-view side45 --max-series 50 --max-per-series 30
```

全量车系抓够 100 张即停止（全局上限），并限制分辨率与年份：

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --max-total 100 --min-size 721 --min-year 2020 --max-year 2025 --sleep 0.3
```

每个车型版本（specid）只要前/后/侧 3 张图（每个视角 1 张）：

```bash
pip install numpy opencv-python
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --min-size 721 --min-year 2020 --max-year 2025 --view-scheme front_back_front45_back45 --view-bins front_back_side --max-per-view 1 --required-views front,back,side
```

说明：

- `front_back_front45_back45` 识别更细：`front/back/side/front45/back45`
- `--view-bins front_back_side` 会把 `side/front45/back45/side45` 归并为 `side`，从而实现“前/后/侧”三类
- `--max-per-view 1` + `--required-views front,back,side` 表示：每个 spec 只要凑齐 3 个视角各 1 张就停止该 spec

每个车型版本（specid）要前/后/侧/侧45 一共 4 张图（每个视角 1 张）：

```bash
pip install numpy opencv-python
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --min-size 721 --min-year 2020 --max-year 2025 --view-scheme front_back_45 --view-bins raw --max-per-view 1 --required-views front,back,side,side45
```

说明：

- `front_back_45` 会输出 `front/back/side/side45`（纯侧面为 side；45 度为 side45）
- `--view-bins raw` 表示保留四类不归并

`--view-scheme` 也支持用逗号列出期望视角（会自动选择内部方案，并在未指定 `--only-view` 时自动只保留这些视角）：

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --view-scheme front,back,side
```

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --view-scheme front,back,side,side45
```

同样也适用于单车系脚本：

```bash
python -m car_img_get.download_autohome --series 6124 --out ./dataset_png --category 1 --view-scheme front,back,side
```

示例：抓取外观图（category=1），只要 front/back/side 三个视角，每个车型最多 1 种颜色，车型年份 >=2020，全局最多 100 张：

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --max-total 100 --min-year 2020 --view-scheme front,back,side --max-per-view 1 --required-views front,back,side --max-colors-per-spec 1
```

限定颜色种类（避免把每个车型的每个颜色都抓一遍）：

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --only-colors 黑色,白色
```

或限制每个车型版本（specid）最多保留 N 种颜色：

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --max-colors-per-spec 2
```

文件名带上品牌/车系/年份（并保持唯一性，附加 picid）：

```bash
python -m car_img_get.download_autohome_many --out ./dataset_png --category 1 --max-total 100 --min-size 721 --min-year 2020 --max-year 2025
```

常用分类（来自汽车之家图片库）：

- 1：车身外观
- 2：中控方向盘
- 3：车厢座椅
- 10：其它细节
- 53：官图（通常不绑定某一个 spec，需要用 --spec 0）

## specid 是什么

- seriesid：车系 ID（例如“奥迪A6L”这个车系）
- specid：车型版本 ID（某个年款/配置，例如“2024款 40 TFSI 豪华致雅型”）

你看到的 `spec_12345` 文件夹，就是 `specid=12345` 的意思。

## 查询 specid（车型版本ID -> 名称/年份）

按车系列出所有车型版本（specid / year / name）：

```bash
python -c "from car_img_get.autohome_api import AutohomeClient; c=AutohomeClient(); specs=c.get_specs(6124); print('\n'.join([f'{s.specid}\t{s.year}\t{s.name}' for s in specs]))"
```

把 `6124` 换成你关心的 `seriesid` 即可。

## 指定车型（specid）下载

```bash
python -m car_img_get.download_autohome --series 6124 --spec 65520 --out ./dataset_png --category 1
```

## 目录命名格式

分类目录固定按品牌\_车系命名：

```
dataset_png/
  series_6124/
    spec_65520/
      欧拉_欧拉闪电猫/
        欧拉_欧拉闪电猫_2024_9201815.png
```

同时会生成一份 `metadata.jsonl`（每行一个 JSON）记录下载来源与文件路径。

元数据采用 schema v2：

- `categoryid/categoryname`：车辆车身大类，`0=未知、1=轿车、2=SUV、3=MPV、4=跑车、5=微面、6=轻客、7=皮卡、8=卡车、9=客车`。
- `category_source`：汽车之家车系接口返回的 `levelId/levelName`，用于追溯车身大类映射。
- `image_categoryid/image_typeid`：汽车之家图片库原始图片分类；命令行 `--category` 对应 `image_categoryid`。
- `view/view_confidence/view_model/view_source`：唯一的角度分类结果及其模型信息，不再写入 `view_raw/view_scheme/view_features/quality.view`。

清洗历史元数据并用当前 YOLO 角度模型重新分类：

```bash
python -m car_img_get.clean_metadata --input ./dataset_png/metadata.jsonl
```

命令默认生成 `metadata.cleaned.jsonl`，并在 `_metadata_migration/` 中保留车系信息和角度预测缓存，方便断点续跑与审计。该命令不会直接覆盖正式的 `metadata.jsonl`。

常用参数：

- `--output PATH`：指定清洗结果文件。
- `--model PATH`：指定角度分类模型；默认使用项目内置的 YOLO11 角度模型。
- `--device auto|cpu|cuda:0`：指定推理设备。
- `--batch-size N`：角度分类批量大小，默认 `8`；显存不足时调小。
- `--no-fetch-series`：只使用 `_metadata_migration/series_info.json`，不联网补充车系级别。
- `--limit N`：只处理前 N 条，用于试运行；默认处理全部记录。
- `--force`：允许覆盖已存在的输出文件。

推荐先生成结果并检查：

```powershell
python -m car_img_get.clean_metadata `
  --input ./dataset_png/metadata.jsonl `
  --output ./dataset_png/metadata.cleaned.jsonl `
  --device auto `
  --batch-size 8 `
  --no-fetch-series `
  --force
```

工具会自动完成以下操作：

1. 按 `seriesid/specid/picid` 去除重复记录，并将去重事件写入 `metadata.cleaned.errors.jsonl`。
2. 根据汽车之家车系级别补充 `categoryid/categoryname`。
3. 使用当前角度分类模型重新识别 `view`，同时记录置信度、模型路径和推理来源。
4. 删除旧版重复角度字段，并校验 schema v2 的必需字段。

确认清洗结果无误后，建议先备份再替换正式文件。PowerShell 示例：

```powershell
$src = Resolve-Path ./dataset_png/metadata.jsonl
$cleaned = Resolve-Path ./dataset_png/metadata.cleaned.jsonl
$backup = "./dataset_png/metadata.backup.$(Get-Date -Format yyyyMMdd-HHmmss).jsonl"
Copy-Item $src $backup
Move-Item $cleaned $src -Force
```

后续模型更新或字段规则调整后，直接重新执行清洗命令即可。`_metadata_migration/` 中的缓存会复用已有角度预测；更换角度模型后，应删除对应的 `view_predictions.jsonl`，或将缓存目录改名后重新生成，避免沿用旧模型结果。

## 汇总收集 dataset\_png 图片

下载脚本会在 `out/metadata.jsonl` 里持续追加写入每张图片的元信息（含 `saved_path` / `view` / `seriesid` / `specid` / `colorname` 等）。如果你想把 `dataset_png/` 下的图片“汇总成一份清单”，或可选“扁平化复制到一个目录”，可以使用：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png
```

默认行为：

- 优先读取 `./dataset_png/metadata.jsonl` 生成清单
- 输出 `./dataset_png/manifest.csv`

清单字段包含：`path/view/brand/series/year/seriesid/specid/colorname`。

只汇总指定视角（例如 front/back/side）。注意：在 `--reclassify-view model` 模式下，`side` 会自动扩展为 `left_side,right_side`：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --views front,back,side
```

如果历史数据里 `view_` 目录/metadata 里的 view 不准确，可在汇总时重新用内置模型判定视角再筛选：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --views front --reclassify-view model --view-min-conf 0.6
```

按条件精确筛选（支持 seriesid/specid/品牌/车系/车型名 specname）：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --only-seriesid 197 --only-specid 68837
```

例如筛选 `series_197/spec_68837/奔驰_奔驰E级` 并复制到 `./data_select`：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --dst ./data_select --mode copy --layout mirror --only-seriesid 197 --only-specid 68837
```

按“品牌+车系+年份”限定每组最多 N 张（例如每个品牌\_车系\_年款最多 50 张）：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --max-per-bsy 50
```

也可以自定义分组键（例如只按品牌限额，每个品牌最多 200 张）：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --group-by brand --max-per-group 200
```

扁平化复制到新目录（并在新目录生成清单）：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --dst ./dataset_flat --mode copy
```

随机抽取 500 张图片到新目录（并生成清单，固定随机种子便于复现）：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --dst ./dataset_ran_select --mode copy --sample 500 --seed 42
```

按“车型（specid）”抽样：随机选取 100 个车型，每个车型固定抽取 5 张图片（并复制到新目录）：

```bash
python -m car_img_get.collect_dataset --src ./dataset_png --dst ./dataset_spec_select --mode copy --layout spec-flat --sample-specs 100 --per-spec 5 --seed 42
```

## 识别并裁剪汽车主体

对 `./data_ran_select` 下的图片进行“汽车主体检测 + 裁剪”，输出到 `./result/recognize`。

依赖：

```bash
pip install numpy opencv-python
```

可选：安装 `ultralytics` 后会优先用 YOLO 检测（更准），否则自动回退到轮廓法：

```bash
pip install ultralytics
```

执行：

```bash
python -m car_img_get.car_recognize --src ./data_ran_select --out ./result/recognize
```

默认会尝试使用 `--model` 指定的 YOLO 模型进行检测，若模型不可用/加载失败则自动回退到 GrabCut 抠图。

只用 GrabCut（不依赖 YOLO 权重下载）：

```bash
python -m car_img_get.car_recognize --src ./data_ran_select --out ./result/recognize --model none
```

输出：

- 裁剪后的图片保存在 `./result/recognize/`（默认 mirror 布局，保留相对路径）
- 处理记录追加写入 `./result/recognize/recognize.jsonl`

## 图片采集与质量门禁平台

安装 Python 依赖并启动前后端：

```bash
pip install -r requirements.txt
cd web_ui
npm install
npm run dev
```

### Docker GPU 部署

服务器需要预先安装 NVIDIA 驱动、Docker Engine、Docker Compose v2 和 NVIDIA Container Toolkit。先确认宿主机及 Docker 均能访问 GPU：

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi
```

复制环境变量模板，并按服务器实际路径修改数据集和模型目录：

```bash
cp .env.example .env
```

关键变量：

- `DATASET_HOST_PATH`：服务器上的 `dataset_png` 绝对路径，容器内统一挂载为 `/data/dataset_png`。
- `MODELS_HOST_PATH`：服务器模型目录，默认项目下的 `./models`，以只读方式挂载到 `/app/models`。
- `NVIDIA_VISIBLE_DEVICES`：允许容器访问的宿主机 GPU，默认 `all`。
- `CUDA_VISIBLE_DEVICES`：采集程序默认使用的容器内 GPU 编号，默认 `0`。
- `TORCH_INDEX_URL`：PyTorch CUDA wheel 源，默认 CUDA 12.8，可支持 RTX PRO 6000 Blackwell（`sm_120`）；其他服务器可按 GPU 和驱动版本调整。
- `APP_PORT`：平台对外端口，默认 `53378`。

模型目录至少应包含：

```text
models/
  birefnet/epoch_120.pth
  view-cls/yolo11m-cls-for-car-view-train7.pt
  view-clean/front-view-clean.pt
```

构建并启动：

```bash
docker compose build
docker compose up -d
docker compose logs -f car_img_get
```

验证容器内 CUDA 和模型挂载：

```bash
docker compose exec car_img_get python3 -c "import torch; print('cuda=', torch.cuda.is_available(), 'device=', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none')"
docker compose exec car_img_get python3 -c "from pathlib import Path; print('models=', sorted(str(p) for p in Path('/app/models').rglob('*.pt'))); print('birefnet=', Path('/app/models/birefnet/epoch_120.pth').is_file())"
```

启动成功后访问 `http://<服务器IP>:53378/crawler`。页面推理设备选择 `auto` 或 `cuda:0` 时会使用 GPU；Compose 通过 `runtime: nvidia` 启用 GPU，并为 PyTorch 设置了 `compute,utility` 驱动能力。服务器可通过 `docker info | grep -i runtime` 确认 `nvidia` 已注册为 Docker runtime。

打开 `http://localhost:5173/crawler`。采集任务默认强制执行以下流水线：

1. `models/birefnet/epoch_120.pth`：扣取汽车主体，落库 PNG 保留透明通道。
2. `models/view-cls/yolo11m-cls-for-car-view-train7.pt`：识别汽车角度。
3. `models/view-clean/<view>-view-clean.pt`：按角度清洗，分类 `1` 合格、`0` 不合格。

只有三个阶段全部成功且清洗结果为 `1` 的图片才会写入 `metadata.jsonl` 和正式图片目录。拒绝记录写入输出目录的 `rejected.jsonl`，包含拒绝原因、角度、置信度和模型路径。目前仅有 `front-view-clean.pt`，因此其他角度会以 `clean_model_missing` 被拒绝，直到对应模型补齐。

方案验证阶段默认启用 `--keep-stage-images`，并以图片内容 MD5 关联保存完整中间产物：

- `_pipeline_stages/original/<view>/`：采集到的原始字节，保留原图片格式。
- `_pipeline_stages/birefnet/<view>/`：BiRefNet 输出的完整分辨率 RGBA PNG。
- `_pipeline_stages/accepted/<view>/`：最终落库决策图。
- `_pipeline_stages/rejected/<view>/<reason>/`：最终拒绝决策图。

角度分类未成功的图片统一放入 `unknown` 目录。

对应路径同时写入 `metadata.jsonl` 或 `rejected.jsonl` 的 `pipeline_artifacts` 字段。生产阶段可通过 `--no-keep-stage-images` 关闭中间产物留档。

### 恢复阶段图片原名

`_pipeline_stages` 中的图片默认以原图 MD5 命名。可以使用 `map_hash_name` 按 `metadata.jsonl` 中的 `md5/saved_path` 将指定目录内的图片恢复为可读原名。工具会递归扫描子目录，并自动使用同目录的 `rejected.jsonl` 补充被拒绝图片的信息。

建议先预演，不修改文件：

```powershell
python -m car_img_get.tools.map_hash_name `
  --input-dir ./dataset_png/_pipeline_stages/accepted/front `
  --dry-run
```

确认输出后原地改名：

```powershell
python -m car_img_get.tools.map_hash_name `
  --input-dir ./dataset_png/_pipeline_stages/accepted/front
```

也可以直接指定整个阶段目录，工具会递归处理其中所有角度和拒绝原因目录：

```powershell
python -m car_img_get.tools.map_hash_name `
  --input-dir ./dataset_png/_pipeline_stages
```

常用参数：

- `--metadata PATH`：显式指定 `metadata.jsonl`；默认从输入目录向上查找 `dataset_png/metadata.jsonl`。
- `--rejected PATH`：显式指定 `rejected.jsonl`；默认使用 `metadata.jsonl` 同目录下的文件。
- `--dry-run`：只输出改名计划，不修改文件。

工具只处理文件名主体为 32 位十六进制 MD5 的文件。找不到元数据的文件保持不变；同一目录发生重名时自动追加 `_001`、`_002`。被拒绝图片没有 `saved_path` 时，会使用 `specname_seriesid_specid_picid` 生成可读名称。正式执行会原地修改 `_pipeline_stages` 文件名，现有记录中的 `pipeline_artifacts` 路径不会自动改写，因此仍需使用采集控制台预览时应保留哈希名称，或仅对阶段目录的副本执行该工具。

命令行示例：

```bash
python -m car_img_get.download_autohome_many \
  --out ./dataset_png \
  --view-scheme front_back_front45_back45 \
  --only-view front \
  --view-min-conf 0.5 \
  --clean-min-conf 0.5 \
  --device auto
```

`--birefnet-size 0` 会在 CUDA 上使用 768、CPU 上使用 320。生产采集建议使用 CUDA；可显式指定 `--birefnet-size 768 --device cuda:0`。调试时可以用 `--no-quality-gate` 关闭门禁，但平台页面不会关闭该门禁。
