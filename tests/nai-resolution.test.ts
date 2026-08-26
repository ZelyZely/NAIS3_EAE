import { describe, expect, it } from 'vitest'
import { snapNaiResolution } from '../src/shared/nai-resolution'

describe('NAI 소스 해상도 스냅', () => {
  it('64 배수로 맞추고 서버 전송 크기와 비용 표시가 공유할 값을 반환한다', () => {
    expect(snapNaiResolution(300, 412)).toEqual({ width: 320, height: 384 })
  })
})
