import { describe, expect, it } from 'vitest'
import {
  generationDefaultsForModel,
  canEnableAnotherCharacter,
  inpaintingModelFor,
  isV5Model,
  modelCapabilities,
  promptTokenLimit
} from '../src/shared/nai-models'

describe('NAI 모델별 동작', () => {
  it('V5 Curated와 Full을 식별한다', () => {
    expect(isV5Model('nai-diffusion-5-curated')).toBe(true)
    expect(isV5Model('nai-diffusion-5-full')).toBe(true)
    expect(isV5Model('nai-diffusion-4-5-full')).toBe(false)
  })

  it('V5 웹 기본값은 23 steps, CFG 7, Euler Ancestral이다', () => {
    expect(generationDefaultsForModel('nai-diffusion-5-full')).toMatchObject({
      steps: 23,
      cfgScale: 7,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      variety: false
    })
  })

  it('V5는 출시 시점에 바이브·정밀 레퍼런스·Variety+를 지원하지 않는다', () => {
    expect(modelCapabilities('nai-diffusion-5-curated')).toMatchObject({
      vibes: false,
      characterReferences: false,
      variety: false,
      noiseScheduleSelection: false,
      transparency: true,
      maxCharacters: 32
    })
  })

  it('V5는 캐릭터 32명까지, V4.5는 6명까지 활성화할 수 있다', () => {
    expect(canEnableAnotherCharacter('nai-diffusion-5-full', 31)).toBe(true)
    expect(canEnableAnotherCharacter('nai-diffusion-5-full', 32)).toBe(false)
    expect(canEnableAnotherCharacter('nai-diffusion-4-5-full', 5)).toBe(true)
    expect(canEnableAnotherCharacter('nai-diffusion-4-5-full', 6)).toBe(false)
  })

  it('프롬프트 한도는 V5 Curated 703, Full 1471이고 V4.5는 512다', () => {
    expect(promptTokenLimit('nai-diffusion-5-curated')).toBe(703)
    expect(promptTokenLimit('nai-diffusion-5-full')).toBe(1471)
    expect(promptTokenLimit('nai-diffusion-4-5-full')).toBe(512)
  })

  it('V5 Full은 전용 인페인트, Curated는 V4.5 Curated 인페인트를 쓴다', () => {
    expect(inpaintingModelFor('nai-diffusion-5-full')).toBe('nai-diffusion-5-full-inpainting')
    expect(inpaintingModelFor('nai-diffusion-5-curated')).toBe(
      'nai-diffusion-4-5-curated-inpainting'
    )
  })
})
