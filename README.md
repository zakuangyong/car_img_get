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

新增web-ui
```bash
cd web_ui
npm install
npm run dev
```
```
