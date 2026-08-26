export const NAI_V5_CURATED = 'nai-diffusion-5-curated'
export const NAI_V5_FULL = 'nai-diffusion-5-full'

export function isV5Model(model: string): boolean {
  return model.startsWith('nai-diffusion-5-')
}

export function isV5FullModel(model: string): boolean {
  return model === NAI_V5_FULL || model === `${NAI_V5_FULL}-inpainting`
}

export function inpaintingModelFor(model: string): string {
  if (model === NAI_V5_CURATED) return 'nai-diffusion-4-5-curated-inpainting'
  if (model === NAI_V5_FULL) return `${NAI_V5_FULL}-inpainting`
  return model.includes('inpainting') ? model : `${model}-inpainting`
}

export interface NaiModelCapabilities {
  vibes: boolean
  characterReferences: boolean
  variety: boolean
  noiseScheduleSelection: boolean
  transparency: boolean
  maxCharacters: number
}

export function modelCapabilities(model: string): NaiModelCapabilities {
  if (isV5Model(model)) {
    return {
      vibes: false,
      characterReferences: false,
      variety: false,
      noiseScheduleSelection: false,
      transparency: true,
      maxCharacters: 32
    }
  }
  return {
    vibes: true,
    characterReferences: true,
    variety: true,
    noiseScheduleSelection: true,
    transparency: false,
    maxCharacters: 6
  }
}

export function canEnableAnotherCharacter(model: string, enabledCount: number): boolean {
  return enabledCount < modelCapabilities(model).maxCharacters
}

export function generationDefaultsForModel(model: string): {
  steps: number
  cfgScale: number
  sampler: string
  noiseSchedule: string
  variety: boolean
} {
  return isV5Model(model)
    ? {
        steps: 23,
        cfgScale: 7,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras',
        variety: false
      }
    : {
        steps: 28,
        cfgScale: 5,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras',
        variety: false
      }
}

/** Current NovelAI web limits: Qwen for V5, T5 for V4/V4.5. */
export function promptTokenLimit(model: string): number {
  if (isV5FullModel(model)) return 1471
  if (isV5Model(model)) return 703
  return 512
}
