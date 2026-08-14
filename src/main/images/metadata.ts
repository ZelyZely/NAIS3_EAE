import { gunzipSync, inflateSync } from 'zlib'
import sharp from 'sharp'
import type { ImageMetadata } from '../../shared/types'
import { QUALITY_TAGS_SUFFIX, UC_PRESETS_V45_FULL } from '../../shared/nai-presets'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const STEALTH_MAGIC = 'stealth_pngcomp'
const LOCAL_PARAM_KEYS = ['nais3-params', 'nais2-params']

/** PNG tEXt/zTXt/iTXt 청크에서 keyword→text 추출 */
export function parsePngTextChunks(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return out
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd > buf.length) break
    const data = buf.subarray(dataStart, dataEnd)
    try {
      if (type === 'tEXt') {
        const nul = data.indexOf(0)
        if (nul >= 0) out[data.toString('latin1', 0, nul)] = data.toString('latin1', nul + 1)
      } else if (type === 'zTXt') {
        const nul = data.indexOf(0)
        if (nul >= 0) {
          const key = data.toString('latin1', 0, nul)
          // data[nul+1] = compression method(0=zlib), 이후 압축 텍스트
          out[key] = inflateSync(data.subarray(nul + 2)).toString('latin1')
        }
      } else if (type === 'iTXt') {
        const nul = data.indexOf(0)
        if (nul >= 0) {
          const key = data.toString('latin1', 0, nul)
          const compFlag = data[nul + 1]
          // nul+3부터 lang\0translated\0text
          let p = nul + 3
          const langEnd = data.indexOf(0, p)
          p = langEnd + 1
          const transEnd = data.indexOf(0, p)
          p = transEnd + 1
          const textBuf = data.subarray(p)
          out[key] =
            compFlag === 1 ? inflateSync(textBuf).toString('utf8') : textBuf.toString('utf8')
        }
      } else if (type === 'IEND') {
        break
      }
    } catch {
      // 개별 청크 파싱 실패는 무시
    }
    off = dataEnd + 4 // + CRC
  }
  return out
}

/**
 * WEBP 손실 압축본용 메타데이터 이전 — PNG tEXt 딕셔너리를 base64 JSON으로 묶어
 * EXIF IFD0.ImageDescription에 싣는다 (WEBP는 tEXt 청크가 없어 EXIF가 유일한 텍스트 컨테이너).
 */
export function encodeTextDictForExif(text: Record<string, string>): string {
  return Buffer.from(JSON.stringify(text), 'utf8').toString('base64')
}

function decodeTextDictFromExif(b64: string): Record<string, string> {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, string>
}

/**
 * TIFF(EXIF) IFD0에서 ImageDescription(tag 0x010e, ASCII) 값만 읽는 최소 파서.
 * sharp가 돌려주는 exif 버퍼는 JPEG APP1 관례대로 "Exif\0\0" 6바이트 프리픽스가 붙어 있고,
 * TIFF 내부 오프셋들은 모두 이 프리픽스 뒤(TIFF 헤더 시작)를 기준으로 한다.
 */
function readExifImageDescription(buf: Buffer): string | undefined {
  const base =
    buf.length >= 6 && buf.toString('ascii', 0, 4) === 'Exif' && buf[4] === 0 && buf[5] === 0
      ? 6
      : 0
  if (buf.length < base + 8) return undefined
  const byteOrder = buf.toString('ascii', base, base + 2)
  const le = byteOrder === 'II'
  if (!le && byteOrder !== 'MM') return undefined
  const u16 = (o: number): number => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o: number): number => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const ifdOffset = base + u32(base + 4)
  if (ifdOffset + 2 > buf.length) return undefined
  const count = u16(ifdOffset)
  for (let i = 0; i < count; i++) {
    const entryOff = ifdOffset + 2 + i * 12
    if (entryOff + 12 > buf.length) break
    const tag = u16(entryOff)
    const type = u16(entryOff + 2)
    if (tag === 0x010e && type === 2) {
      const len = u32(entryOff + 4)
      const dataOff = len <= 4 ? entryOff + 8 : base + u32(entryOff + 8)
      if (dataOff + len > buf.length) return undefined
      const raw = buf.subarray(dataOff, dataOff + len)
      const nul = raw.indexOf(0)
      return raw.toString('utf8', 0, nul >= 0 ? nul : raw.length)
    }
  }
  return undefined
}

/** stealth 메타데이터 (알파 채널 LSB, column-major, magic + gzip JSON) */
async function extractStealthComment(buf: Buffer): Promise<Record<string, unknown> | null> {
  try {
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const { width, height, channels } = info
    const total = width * height
    const bytes = new Uint8Array(Math.ceil(total / 8))
    let bitIdx = 0
    // column-major 알파 LSB → MSB-first 패킹 (np.packbits와 동일)
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const a = data[(y * width + x) * channels + 3] & 1
        if (a) bytes[bitIdx >> 3] |= 1 << (7 - (bitIdx & 7))
        bitIdx++
      }
    }
    const magic = Buffer.from(STEALTH_MAGIC, 'ascii')
    for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return null
    let off = magic.length
    const lengthBits =
      (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]
    off += 4
    const lengthBytes = Math.ceil(lengthBits / 8)
    const compressed = Buffer.from(bytes.slice(off, off + lengthBytes))
    const json = JSON.parse(gunzipSync(compressed).toString('utf8')) as Record<string, unknown>
    if (typeof json.Comment === 'string') json.Comment = JSON.parse(json.Comment)
    return json
  } catch {
    return null
  }
}

interface Params {
  steps?: number
  scale?: number
  cfg_rescale?: number
  sampler?: string
  noise_schedule?: string
  seed?: number
  width?: number
  height?: number
  skip_cfg_above_sigma?: number | null
  negative_prompt?: string
  ucPreset?: number
  qualityToggle?: boolean
  use_coords?: boolean
  v4_prompt?: {
    use_coords?: boolean
    caption?: { char_captions?: { char_caption?: string; centers?: { x: number; y: number }[] }[] }
  }
  v4_negative_prompt?: { caption?: { char_captions?: { char_caption?: string }[] } }
}

interface LocalParams {
  promptParts?: ImageMetadata['promptParts']
}

function parseLocalParams(text: Record<string, string>): LocalParams | undefined {
  for (const key of LOCAL_PARAM_KEYS) {
    const raw = text[key]
    if (!raw) continue
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as LocalParams
    } catch {
      try {
        return JSON.parse(raw) as LocalParams
      } catch {
        // 다음 후보 확인
      }
    }
  }
  return undefined
}

/** 병합된 네거티브에서 UC 프리셋 인덱스 역추적 (프리셋 텍스트가 접두인 것 중 가장 긴 것) */
function inferUcPreset(uc: string): number | undefined {
  let best: number | undefined
  let bestLen = -1
  for (const [k, preset] of Object.entries(UC_PRESETS_V45_FULL)) {
    if (!preset) continue
    if ((uc === preset || uc.startsWith(preset + ', ')) && preset.length > bestLen) {
      best = Number(k)
      bestLen = preset.length
    }
  }
  return best
}

/** 파라미터 객체 + 프롬프트/모델 → 정규화 메타 */
function normalize(
  params: Params,
  extra: { prompt: string; uc: string; model?: string; software?: string; local?: LocalParams }
): ImageMetadata {
  const posChars = params.v4_prompt?.caption?.char_captions ?? []
  const negChars = params.v4_negative_prompt?.caption?.char_captions ?? []
  const characterPrompts = posChars.map((c, i) => ({
    prompt: c?.char_caption ?? '',
    negativePrompt: negChars[i]?.char_caption ?? '',
    center: c?.centers?.[0]
  }))
  return {
    prompt: extra.prompt,
    promptParts: extra.local?.promptParts,
    negativePrompt: extra.uc,
    seed: params.seed,
    steps: params.steps,
    cfgScale: params.scale,
    cfgRescale: params.cfg_rescale,
    sampler: params.sampler,
    noiseSchedule: params.noise_schedule,
    width: params.width,
    height: params.height,
    model: extra.model,
    software: extra.software,
    variety: params.skip_cfg_above_sigma != null,
    useCoords: params.v4_prompt?.use_coords ?? params.use_coords ?? false,
    // ucPreset·qualityToggle: 직접 필드 우선, 없으면 병합 문자열에서 역추적
    qualityToggle: params.qualityToggle ?? extra.prompt.endsWith(QUALITY_TAGS_SUFFIX),
    ucPreset: params.ucPreset ?? inferUcPreset(extra.uc),
    characterPrompts: characterPrompts.length > 0 ? characterPrompts : undefined
  }
}

/** 우리 payload_json({input, model, parameters}) → 정규화 메타 */
export function metadataFromPayloadJson(json: string): ImageMetadata | null {
  try {
    const p = JSON.parse(json) as {
      input?: string
      model?: string
      parameters?: Params
      nais3?: LocalParams
    }
    if (!p.parameters) return null
    return normalize(p.parameters, {
      prompt: p.input ?? '',
      uc: p.parameters.negative_prompt ?? '',
      model: p.model,
      software: 'NAIS3',
      local: p.nais3
    })
  } catch {
    return null
  }
}

/** WEBP(EXIF ImageDescription) → PNG tEXt와 동일한 keyword→text 딕셔너리로 복원 */
async function textDictFromWebp(buf: Buffer): Promise<Record<string, string>> {
  try {
    const { exif } = await sharp(buf).metadata()
    if (!exif) return {}
    const b64 = readExifImageDescription(exif)
    return b64 ? decodeTextDictFromExif(b64) : {}
  } catch {
    return {}
  }
}

/** PNG/WEBP 버퍼 → 정규화 메타 (tEXt/EXIF Comment → stealth 폴백[PNG 한정]). 없으면 null */
export async function metadataFromImage(buf: Buffer): Promise<ImageMetadata | null> {
  const isPng = buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)
  const text = isPng ? parsePngTextChunks(buf) : await textDictFromWebp(buf)
  const local = parseLocalParams(text)
  let comment: Params | null = null
  let extra = {
    software: text.Software,
    model: text.Source,
    description: text.Description
  }
  if (text.Comment) {
    try {
      comment = JSON.parse(text.Comment) as Params
    } catch {
      comment = null
    }
  }
  // stealth(알파 LSB)는 원본 PNG 전용 — 손실 WEBP 재압축본은 항상 EXIF에 명시적으로 싣기 때문에 불필요
  if (!comment && isPng) {
    const stealth = await extractStealthComment(buf)
    if (stealth) {
      comment = (stealth.Comment as Params) ?? (stealth as Params)
      if (typeof stealth.Software === 'string') extra = { ...extra, software: stealth.Software }
      if (typeof stealth.Source === 'string') extra = { ...extra, model: stealth.Source }
    }
  }
  if (!comment) return null
  const c = comment as Params & { prompt?: string; uc?: string }
  return normalize(comment, {
    prompt: c.prompt ?? extra.description ?? '',
    uc: c.uc ?? '',
    model: extra.model,
    software: extra.software,
    local
  })
}
