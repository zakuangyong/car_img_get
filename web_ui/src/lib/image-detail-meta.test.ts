import assert from 'node:assert/strict'
import test from 'node:test'

import { buildImageMetaPanel } from './image-detail-meta'

test('buildImageMetaPanel groups key fields and preserves unknown metadata', () => {
  const meta = {
    id: '946',
    filePath: 'series_106/spec_61173/front/car.png',
    brand: '别克',
    model: 'GL8',
    year: 2023,
    view: 'front',
    view_score: 0.98,
    quality: 'accepted',
    width: 1400,
    height: 1050,
    url: 'https://example.com/car.png',
    savedPath: 'dataset_png/series_106/spec_61173/front/car.png',
    cloud_detector: 'full',
    surprise_field: '保留我',
  }

  const panel = buildImageMetaPanel(meta)

  assert.deepEqual(
    panel.summary.map((item) => item.label),
    ['品牌', '车型', '年份', '视角', '质量', '云检测'],
  )
  assert.equal(panel.sections[0]?.title, '基础信息')
  assert.equal(panel.sections.some((section) => section.title === '图像信息'), true)
  assert.equal(panel.sections.some((section) => section.title === '视角与质量'), true)
  assert.equal(panel.sections.some((section) => section.title === '来源与路径'), true)

  const otherSection = panel.sections.find((section) => section.title === '其他信息')
  assert.equal(
    otherSection?.items.some((item) => item.label === 'surprise_field' && item.value === '保留我'),
    true,
  )

  const pathSection = panel.sections.find((section) => section.title === '来源与路径')
  assert.equal(pathSection?.items.some((item) => item.label === 'url' && item.multiline === true), true)
  assert.equal(pathSection?.items.some((item) => item.label === 'savedPath' && item.multiline === true), true)
  assert.equal(pathSection?.items.some((item) => item.label === 'filePath' && item.multiline === true), true)
})

test('buildImageMetaPanel supports snake_case api fields in the correct sections', () => {
  const panel = buildImageMetaPanel({
    id: 'api-1',
    filePath: 'dataset_png/series_106/spec_61173/front/car.png',
    brand: '别克',
    model: 'GL8',
    year: 2023,
    view: 'front',
    quality: 'accepted',
    cloud_detector: 'full',
    seriesid: 106,
    specid: 61173,
    categoryid: 1,
    picid: 998877,
    image_typeid: 12,
    width: 1400,
    height: 1050,
    view_confidence: 0.98,
    view_source: 'yolo11_view_classifier',
    saved_path: 'dataset_png/series_106/spec_61173/front/car.png',
  })

  assert.deepEqual(
    panel.summary.map((item) => item.label),
    ['品牌', '车型', '年份', '视角', '质量', '来源', '云检测'],
  )

  const basicSection = panel.sections.find((section) => section.title === '基础信息')
  assert.equal(basicSection?.items.some((item) => item.label === 'seriesid' && item.value === '106'), true)
  assert.equal(basicSection?.items.some((item) => item.label === 'specid' && item.value === '61173'), true)
  assert.equal(basicSection?.items.some((item) => item.label === 'categoryid' && item.value === '1'), true)
  assert.equal(basicSection?.items.some((item) => item.label === 'picid' && item.value === '998877'), true)
  assert.equal(basicSection?.items.some((item) => item.label === 'image_typeid' && item.value === '12'), true)

  const qualitySection = panel.sections.find((section) => section.title === '视角与质量')
  assert.equal(qualitySection?.items.some((item) => item.label === 'view_confidence' && item.value === '0.98'), true)
  assert.equal(
    qualitySection?.items.some((item) => item.label === 'view_source' && item.value === 'yolo11_view_classifier'),
    true,
  )

  const pathSection = panel.sections.find((section) => section.title === '来源与路径')
  assert.equal(
    pathSection?.items.some(
      (item) =>
        item.label === 'saved_path' &&
        item.value === 'dataset_png/series_106/spec_61173/front/car.png' &&
        item.multiline === true,
    ),
    true,
  )
})

test('buildImageMetaPanel omits source summary when view_source is empty', () => {
  const panel = buildImageMetaPanel({
    id: 'api-2',
    filePath: 'dataset_png/series_106/spec_61173/front/car.png',
    brand: '别克',
    model: 'GL8',
    year: 2023,
    view: 'front',
    quality: 'accepted',
    cloud_detector: 'full',
    view_source: '',
    saved_path: 'dataset_png/series_106/spec_61173/front/car.png',
    url: 'https://example.com/car.png',
  })

  assert.deepEqual(
    panel.summary.map((item) => item.label),
    ['品牌', '车型', '年份', '视角', '质量', '云检测'],
  )
})

test('buildImageMetaPanel supports standard snake_case id fields in base section', () => {
  const panel = buildImageMetaPanel({
    id: 'api-3',
    filePath: 'dataset_png/series_106/spec_61173/front/car.png',
    brand: '别克',
    model: 'GL8',
    year: 2023,
    view: 'front',
    quality: 'accepted',
    cloud_detector: 'full',
    series_id: 106,
    spec_id: 61173,
    category_id: 1,
    pic_id: 998877,
  })

  const basicSection = panel.sections.find((section) => section.title === '基础信息')
  assert.equal(basicSection?.items.some((item) => item.label === 'series_id' && item.value === '106'), true)
  assert.equal(basicSection?.items.some((item) => item.label === 'spec_id' && item.value === '61173'), true)
  assert.equal(basicSection?.items.some((item) => item.label === 'category_id' && item.value === '1'), true)
  assert.equal(basicSection?.items.some((item) => item.label === 'pic_id' && item.value === '998877'), true)
})

test('buildImageMetaPanel omits blank fields and marks long url or path values as multiline', () => {
  const panel = buildImageMetaPanel({
    id: 'api-4',
    brand: '别克',
    model: '   ',
    filePath: 'dataset_png/x/front.png',
    savedPath: '   ',
    cloud_detector: '  ',
    source_url: 'https://example.com/assets/review/front/car-image.png?token=abcdefg1234567890',
    archive_path: 'dataset_png/series_106/spec_61173/front/review-assets/front-car-image-final.png',
  })

  assert.equal(panel.summary.some((item) => item.label === '车型'), false)
  assert.equal(panel.summary.some((item) => item.label === '云检测'), false)

  const pathSection = panel.sections.find((section) => section.title === '来源与路径')
  assert.equal(pathSection?.items.some((item) => item.label === 'savedPath'), false)

  const otherSection = panel.sections.find((section) => section.title === '其他信息')
  assert.equal(
    otherSection?.items.some((item) => item.label === 'source_url' && item.multiline === true),
    true,
  )
  assert.equal(
    otherSection?.items.some((item) => item.label === 'archive_path' && item.multiline === true),
    true,
  )
})

test('buildImageMetaPanel assigns readable tones for quality and source-related summary chips', () => {
  const rejectedPanel = buildImageMetaPanel({
    id: 'api-5',
    filePath: 'dataset_png/x/front.png',
    brand: '别克',
    quality: 'rejected',
    view: 'front',
    view_source: 'yolo11_view_classifier',
  })

  assert.equal(rejectedPanel.summary.find((item) => item.label === '质量')?.tone, 'warn')
  assert.equal(rejectedPanel.summary.find((item) => item.label === '视角')?.tone, 'accent')
  assert.equal(rejectedPanel.summary.find((item) => item.label === '来源')?.tone, 'accent')
})
