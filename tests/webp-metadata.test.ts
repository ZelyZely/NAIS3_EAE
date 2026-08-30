import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  encodeTextDictForExif,
  metadataFromImage,
  textDictFromImage
} from '../src/main/images/metadata'

// ── PNG tEXt 주입 (NAI가 주는 PNG를 흉내낸다) ────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function textChunk(keyword: string, value: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'latin1')
  ])
  const type = Buffer.from('tEXt', 'ascii')
  const out = Buffer.alloc(4 + 4 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  type.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)
  return out
}

function withTextChunks(png: Buffer, text: Record<string, string>): Buffer {
  const chunks = Object.entries(text).map(([k, v]) => textChunk(k, v))
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)])
}

const PROMPT = '1girl, silver hair, {{masterpiece}}'
const MODEL = 'NovelAI Diffusion V4.5 4BDE2A90'
const COMMENT = JSON.stringify({
  prompt: PROMPT,
  uc: 'lowres',
  seed: 1234567890,
  steps: 28,
  scale: 5,
  sampler: 'k_euler_ancestral',
  width: 832,
  height: 1216
})
const NAI_TEXT = {
  Title: 'NovelAI generated image',
  Description: PROMPT,
  Software: 'NovelAI',
  Source: MODEL,
  Comment: COMMENT
}

async function blankPng(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } })
    .png()
    .toBuffer()
}

/**
 * storage.ts의 compressToLossyWebp와 같은 EXIF 배치로 재압축한다.
 * 여기가 어긋나면 실제 저장본도 읽히지 않으므로 배치를 그대로 따라간다.
 */
async function recompress(
  src: Buffer,
  localMetadata?: { promptParts: unknown }
): Promise<Buffer> {
  const text = await textDictFromImage(src)
  if (localMetadata) {
    text['nais3-params'] = Buffer.from(
      JSON.stringify({ version: 1, ...localMetadata }),
      'utf8'
    ).toString('base64')
  }
  const std: Record<string, string> = { Artist: encodeTextDictForExif(text) }
  if (text.Description) std.ImageDescription = text.Description
  if (text.Software) std.Software = text.Software
  if (text.Source) std.Model = text.Source
  return sharp(src).keepMetadata().webp({ quality: 80 }).withExifMerge({ IFD0: std }).toBuffer()
}

describe('손실 WEBP 메타데이터 보존', () => {
  it('PNG tEXt → 재압축 WEBP에서 그대로 읽힌다', async () => {
    const png = withTextChunks(await blankPng(), NAI_TEXT)
    const webp = await recompress(png, { promptParts: { base: 'silver hair' } })

    const meta = await metadataFromImage(webp)
    expect(meta).not.toBeNull()
    expect(meta?.prompt).toBe(PROMPT)
    expect(meta?.seed).toBe(1234567890)
    expect(meta?.steps).toBe(28)
    expect(meta?.model).toBe(MODEL)
    expect(meta?.software).toBe('NovelAI')
    expect(meta?.promptParts).toEqual({ base: 'silver hair' })
  })

  it('사람이 읽는 프롬프트·모델은 표준 EXIF 태그에도 남는다', async () => {
    const png = withTextChunks(await blankPng(), NAI_TEXT)
    const webp = await recompress(png)

    // 외부 메타데이터 뷰어가 보는 자리 — base64 덩어리가 아니라 프롬프트여야 한다
    const dict = await textDictFromImage(webp)
    expect(dict.Description).toBe(PROMPT)
    expect(dict.Source).toBe(MODEL)
  })

  it('원본이 이미 WEBP여도(image_format=webp) 메타데이터가 살아남는다', async () => {
    // NAI가 WEBP로 준 상황: 표준 EXIF 태그에만 정보가 있다
    const naiWebp = await sharp(await blankPng())
      .webp({ quality: 90 })
      .withExif({ IFD0: { ImageDescription: PROMPT, Software: 'NovelAI', Model: MODEL } })
      .toBuffer()

    const dict = await textDictFromImage(naiWebp)
    expect(dict.Description).toBe(PROMPT)
    expect(dict.Software).toBe('NovelAI')
    expect(dict.Source).toBe(MODEL)

    // 예전엔 여기서 PNG tEXt만 읽어 빈 딕셔너리를 써 넣고 전부 날렸다
    const recompressed = await textDictFromImage(await recompress(naiWebp))
    expect(recompressed.Description).toBe(PROMPT)
    expect(recompressed.Source).toBe(MODEL)
  })

  it('재압축본을 또 재압축해도 유지된다', async () => {
    const png = withTextChunks(await blankPng(), NAI_TEXT)
    const once = await recompress(png, { promptParts: { base: 'silver hair' } })
    const twice = await recompress(once)

    const meta = await metadataFromImage(twice)
    expect(meta?.prompt).toBe(PROMPT)
    expect(meta?.seed).toBe(1234567890)
    expect(meta?.promptParts).toEqual({ base: 'silver hair' })
  })

  it('v1.0.22 이전 저장본(ImageDescription에 딕셔너리)도 읽힌다', async () => {
    const legacy = await sharp(await blankPng())
      .webp({ quality: 80 })
      .withExif({ IFD0: { ImageDescription: encodeTextDictForExif(NAI_TEXT) } })
      .toBuffer()

    const meta = await metadataFromImage(legacy)
    expect(meta?.prompt).toBe(PROMPT)
    expect(meta?.seed).toBe(1234567890)
  })

  it('메타데이터를 뺀 재압축본은 EXIF가 없다', async () => {
    const png = withTextChunks(await blankPng(), NAI_TEXT)
    const stripped = await sharp(png).webp({ quality: 80 }).toBuffer()

    expect((await sharp(stripped).metadata()).exif).toBeUndefined()
    expect(await metadataFromImage(stripped)).toBeNull()
  })
})
