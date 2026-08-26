/** 소스 해상도를 유효 NAI 해상도로 스냅 — 64 배수, 픽셀 상한 내에서 비율 최대한 보존 */
export function snapNaiResolution(w: number, h: number): { width: number; height: number } {
  const maxPixels = 1216 * 1216
  let width = w
  let height = h
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height))
    width *= scale
    height *= scale
  }
  const snap = (value: number): number => Math.max(64, Math.round(value / 64) * 64)
  return { width: snap(width), height: snap(height) }
}
