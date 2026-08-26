import { describe, expect, it, vi } from 'vitest'
import {
  chooseNaiAccount,
  isOpusUsageExhausted,
  requestUsesV5Usage,
  type NaiAccountBalance
} from '../src/main/nai/account-router'
import type { GenerationRequest } from '../src/shared/types'

const accounts = [
  { id: 'a', label: 'A', token: 'token-a' },
  { id: 'b', label: 'B', token: 'token-b' },
  { id: 'c', label: 'C', token: 'token-c' }
]

function balance(percent: number, isNegative = false): NaiAccountBalance {
  return {
    anlas: 1000,
    tier: 'opus',
    usage: { percent, isNegative, timeUntilNextPercent: 100 }
  }
}

describe('NAI 다계정 V5 순환', () => {
  const request = {
    model: 'nai-diffusion-5-curated',
    source: undefined
  } as unknown as GenerationRequest

  it('V5 i2i는 순환 대상이고 V4.5로 폴백하는 V5 Curated 인페인트는 제외한다', () => {
    expect(
      requestUsesV5Usage({ ...request, source: { imageBase64: 'x', strength: 0.7, noise: 0 } })
    ).toBe(true)
    expect(
      requestUsesV5Usage({
        ...request,
        source: { imageBase64: 'x', maskBase64: 'mask', strength: 1, noise: 0 }
      })
    ).toBe(false)
    expect(
      requestUsesV5Usage({
        ...request,
        model: 'nai-diffusion-5-full',
        source: { imageBase64: 'x', maskBase64: 'mask', strength: 1, noise: 0 }
      })
    ).toBe(true)
  })

  it('0%와 isNegative를 모두 소진으로 판정한다', () => {
    expect(isOpusUsageExhausted(balance(0))).toBe(true)
    expect(isOpusUsageExhausted(balance(25, true))).toBe(true)
    expect(isOpusUsageExhausted(balance(1))).toBe(false)
  })

  it('활성 계정이 소진되면 원형 순서의 다음 사용 가능한 Opus 계정을 고른다', async () => {
    const lookup = vi.fn(async (token: string) => {
      if (token === 'token-a') return balance(0)
      if (token === 'token-b') return balance(0, true)
      return balance(37)
    })

    const selected = await chooseNaiAccount(accounts, 'a', true, lookup)
    expect(selected.account.id).toBe('c')
    expect(selected.rotated).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it('V5 게이지를 쓰지 않는 요청은 계정 상태를 조회하거나 전환하지 않는다', async () => {
    const lookup = vi.fn(async () => balance(0))
    const selected = await chooseNaiAccount(accounts, 'a', false, lookup)
    expect(selected.account.id).toBe('a')
    expect(selected.rotated).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('후보가 non-Opus이거나 상태를 확인할 수 없으면 자동 선택하지 않는다', async () => {
    const lookup = vi.fn(async (token: string): Promise<NaiAccountBalance> => {
      if (token === 'token-a') return balance(0)
      if (token === 'token-b') return { anlas: 1000, tier: 'scroll' }
      return { anlas: null, tier: null }
    })

    const selected = await chooseNaiAccount(accounts, 'a', true, lookup)
    expect(selected.account.id).toBe('a')
    expect(selected.rotated).toBe(false)
  })

  it('활성 계정에 잔량이 있으면 다른 계정을 조회하지 않는다', async () => {
    const lookup = vi.fn(async () => balance(1))
    const selected = await chooseNaiAccount(accounts, 'b', true, lookup)
    expect(selected.account.id).toBe('b')
    expect(selected.rotated).toBe(false)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})
