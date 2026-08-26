import { describe, expect, it } from 'vitest'
import {
  getVibeEncoding,
  putVibeEncoding,
  vibeEncodingModels
} from '../src/main/refs/vibe-encoding-cache'

describe('모델별 바이브 인코딩 캐시', () => {
  it('기존 단일 캐시는 V4.5 Full 인코딩으로 호환한다', () => {
    expect(getVibeEncoding('legacy-base64', 0.7, 'nai-diffusion-4-5-full', 0.7)).toBe(
      'legacy-base64'
    )
    expect(getVibeEncoding('legacy-base64', 0.7, 'nai-diffusion-4-5-curated', 0.7)).toBeNull()
  })

  it('Curated 인코딩을 추가해도 기존 Full 인코딩을 보존한다', () => {
    const packed = putVibeEncoding(
      'legacy-base64',
      0.7,
      'nai-diffusion-4-5-curated',
      0.7,
      'curated-base64'
    )
    expect(getVibeEncoding(packed, 0.7, 'nai-diffusion-4-5-full', 0.7)).toBe('legacy-base64')
    expect(getVibeEncoding(packed, 0.7, 'nai-diffusion-4-5-curated', 0.7)).toBe('curated-base64')
    expect(vibeEncodingModels(packed, 0.7, 0.7)).toEqual([
      'nai-diffusion-4-5-curated',
      'nai-diffusion-4-5-full'
    ])
  })
})
