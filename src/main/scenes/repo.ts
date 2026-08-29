import { BrowserWindow, dialog } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { unlink } from 'fs/promises'
import { dirname, extname, isAbsolute, join, relative } from 'path'
import JSZip from 'jszip'
import sharp from 'sharp'
import type { ListFolder, Scene, SceneImage, ScenePreset, ScenePresetOrderEntry } from '../../shared/types'
import { getDb } from '../db'
import { dropMemoryImage, isMemoryPath, libraryRoot, presetDir, sceneDir } from '../images/storage'

interface Row {
  id: number
  preset_id: number
  name: string
  prompt: string
  negative_prompt: string
  width: number
  height: number
  reserve_count: number
  reserve_json?: string | null
}

/** 출연별 예약 내역 파싱 (키 '' = 사이드바) */
function parseReserves(raw: string | null): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && v > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 씬의 출연별 예약 내역 설정 — reserve_count(합계)도 함께 갱신 */
export function setSceneReserves(id: number, reserves: Record<string, number>): void {
  const clean: Record<string, number> = {}
  let total = 0
  for (const [k, v] of Object.entries(reserves)) {
    if (typeof v === 'number' && v > 0) {
      clean[k] = v
      total += v
    }
  }
  getDb()
    .prepare('UPDATE gen_scenes SET reserve_json = ?, reserve_count = ? WHERE id = ?')
    .run(total > 0 ? JSON.stringify(clean) : null, total, id)
}

function toScene(r: Row & { image_count: number; has_favorite?: number }): Scene {
  return {
    id: r.id,
    presetId: r.preset_id,
    name: r.name,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    width: r.width,
    height: r.height,
    reserveCount: r.reserve_count,
    reserves: parseReserves(r.reserve_json ?? null),
    // 원본 폴백 경로 — 서버는 항상 '' (렌더러가 방금 생성 직후에만 낙관적으로 채움).
    // 평상시 카드 썸네일은 nais-image://local/?scene=<id> 프로토콜 지연 로드로 표시
    thumbnailPath: '',
    imageCount: r.image_count,
    hasFavorite: r.has_favorite === 1
  }
}

// ── 프리셋 ──────────────────────────────────────────────
export function listPresets(): { folders: ListFolder[]; items: ScenePreset[] } {
  const db = getDb()
  const folders = (
    db
      .prepare('SELECT id, name, collapsed, color FROM scene_preset_folders ORDER BY sort_order')
      .all() as { id: number; name: string; collapsed: number; color: string | null }[]
  ).map((f) => ({ id: f.id, name: f.name, collapsed: f.collapsed === 1, color: f.color }))

  const rows = db
    .prepare(
      `SELECT id, name, default_width AS defaultWidth, default_height AS defaultHeight,
              character_ids, folder_id FROM scene_presets ORDER BY sort_order, id`
    )
    .all() as (Omit<ScenePreset, 'characterIds' | 'folderId'> & {
    character_ids: string | null
    folder_id: number | null
  })[]
  const items = rows.map(({ character_ids, folder_id, ...r }) => {
    let characterIds: number[] | null = null
    try {
      characterIds = character_ids ? (JSON.parse(character_ids) as number[]) : null
    } catch {
      // 깨진 JSON은 바인드 없음으로
    }
    return { ...r, characterIds, folderId: folder_id }
  })
  return { folders, items }
}

/** 프리셋 저장 폴더 경로용 — 프리셋 이름 + 소속 폴더 이름 */
export function getPresetPath(id: number): { name: string; folderName: string | null } | null {
  const r = getDb()
    .prepare(
      `SELECT p.name AS name, f.name AS folder_name
       FROM scene_presets p LEFT JOIN scene_preset_folders f ON f.id = p.folder_id
       WHERE p.id = ?`
    )
    .get(id) as { name: string; folder_name: string | null } | undefined
  return r ? { name: r.name, folderName: r.folder_name } : null
}

/**
 * 프리셋 저장 폴더를 실제로 이동 + 소속 이미지들의 file_path를 새 경로로 갱신.
 * 이동 중 실패(대상 경로 충돌 등)하면 예외를 던지고 아무것도 바뀌지 않는다(디스크 이동이
 * 성공한 뒤 DB 갱신만 실패하면 디스크를 원위치로 되돌린다).
 */
function movePresetDirectory(
  presetId: number,
  oldFolderName: string | null,
  oldName: string,
  newFolderName: string | null,
  newName: string
): void {
  const oldPath = presetDir(oldFolderName, oldName)
  const newPath = presetDir(newFolderName, newName)
  if (oldPath === newPath) return
  if (!existsSync(oldPath)) return // 아직 생성된 이미지 없음 — 이동할 디스크 실체가 없다
  if (existsSync(newPath)) {
    throw new Error(`대상 위치에 이미 "${newName}" 폴더가 있습니다`)
  }
  mkdirSync(dirname(newPath), { recursive: true })
  renameSync(oldPath, newPath)
  try {
    getDb()
      .prepare(
        `UPDATE images SET file_path = ? || substr(file_path, ?)
         WHERE scene_id IN (SELECT id FROM gen_scenes WHERE preset_id = ?)
           AND substr(file_path, 1, ?) = ?`
      )
      .run(newPath, oldPath.length + 1, presetId, oldPath.length, oldPath)
  } catch (e) {
    try {
      renameSync(newPath, oldPath) // DB 갱신 실패 — 디스크 이동 롤백
    } catch {
      // 원복도 실패한 드문 경우 — 파일은 새 위치, DB 경로는 옛 위치로 남는다
    }
    throw e
  }
}

// ── 프리셋 폴더 ──────────────────────────────────────────
export function createPresetFolder(name: string): number {
  const db = getDb()
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM scene_preset_folders')
    .get() as { m: number }
  return Number(
    db
      .prepare('INSERT INTO scene_preset_folders (name, sort_order) VALUES (?, ?)')
      .run(name, max.m + 1).lastInsertRowid
  )
}

/** 폴더 이름 변경 — 소속 프리셋 전부의 저장 폴더도 함께 이동 (하나라도 실패하면 전부 롤백) */
export function renamePresetFolder(id: number, name: string): void {
  const db = getDb()
  const folder = db.prepare('SELECT name FROM scene_preset_folders WHERE id = ?').get(id) as
    | { name: string }
    | undefined
  if (!folder) return
  const presets = db
    .prepare('SELECT id, name FROM scene_presets WHERE folder_id = ?')
    .all(id) as { id: number; name: string }[]
  const moved: { id: number; name: string }[] = []
  try {
    for (const p of presets) {
      movePresetDirectory(p.id, folder.name, p.name, name, p.name)
      moved.push(p)
    }
  } catch (e) {
    for (const m of moved.reverse()) {
      try {
        movePresetDirectory(m.id, name, m.name, folder.name, m.name)
      } catch {
        // best-effort 롤백
      }
    }
    throw e
  }
  db.prepare('UPDATE scene_preset_folders SET name = ? WHERE id = ?').run(name, id)
}

export function setPresetFolderCollapsed(id: number, collapsed: boolean): void {
  getDb()
    .prepare('UPDATE scene_preset_folders SET collapsed = ? WHERE id = ?')
    .run(collapsed ? 1 : 0, id)
}

export function setPresetFolderColor(id: number, color: string | null): void {
  getDb().prepare('UPDATE scene_preset_folders SET color = ? WHERE id = ?').run(color, id)
}

/** 폴더 삭제 — 소속 프리셋은 미분류로 (저장 폴더도 루트로 실제 이동). 이동 실패 시 전부 롤백 */
export function deletePresetFolder(id: number): void {
  const db = getDb()
  const folder = db.prepare('SELECT name FROM scene_preset_folders WHERE id = ?').get(id) as
    | { name: string }
    | undefined
  if (!folder) return
  const presets = db
    .prepare('SELECT id, name FROM scene_presets WHERE folder_id = ?')
    .all(id) as { id: number; name: string }[]
  const moved: { id: number; name: string }[] = []
  try {
    for (const p of presets) {
      movePresetDirectory(p.id, folder.name, p.name, null, p.name)
      moved.push(p)
    }
  } catch (e) {
    for (const m of moved.reverse()) {
      try {
        movePresetDirectory(m.id, null, m.name, folder.name, m.name)
      } catch {
        // best-effort 롤백
      }
    }
    throw e
  }
  db.transaction(() => {
    db.prepare('UPDATE scene_presets SET folder_id = NULL WHERE folder_id = ?').run(id)
    db.prepare('DELETE FROM scene_preset_folders WHERE id = ?').run(id)
  })()
}

/** 프리셋의 새 씬 기본 해상도 설정 */
export function setPresetDefaultResolution(id: number, width: number, height: number): void {
  getDb()
    .prepare('UPDATE scene_presets SET default_width = ?, default_height = ? WHERE id = ?')
    .run(width, height, id)
}

/** 프리셋 캐릭터 바인드 설정 (null = 해제) */
export function setPresetCharacters(id: number, characterIds: number[] | null): void {
  getDb()
    .prepare('UPDATE scene_presets SET character_ids = ? WHERE id = ?')
    .run(characterIds && characterIds.length > 0 ? JSON.stringify(characterIds) : null, id)
}

export function createPreset(name: string, folderId: number | null = null): number {
  const db = getDb()
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM scene_presets').get() as {
    m: number
  }
  return Number(
    db
      .prepare('INSERT INTO scene_presets (name, folder_id, sort_order) VALUES (?, ?, ?)')
      .run(name, folderId, max.m + 1).lastInsertRowid
  )
}

export function renamePreset(id: number, name: string): void {
  getDb().prepare('UPDATE scene_presets SET name = ? WHERE id = ?').run(name, id)
}

/** 프리셋 삭제 — 마지막 하나는 못 지움. 안의 씬도 함께 삭제(이미지는 scene_id만 끊김) */
export function deletePreset(id: number): void {
  const db = getDb()
  const count = (db.prepare('SELECT COUNT(*) AS c FROM scene_presets').get() as { c: number }).c
  if (count <= 1) return
  db.transaction(() => {
    db.prepare('DELETE FROM gen_scenes WHERE preset_id = ?').run(id)
    db.prepare('DELETE FROM scene_presets WHERE id = ?').run(id)
  })()
}

// ── 씬 ──────────────────────────────────────────────────
/**
 * listScenes/sceneSummaries 공용 SELECT. 썸네일 BLOB은 여기서 읽지 않는다 —
 * 카드는 nais-image://local/?scene=<id> 프로토콜로 지연 로드(렌더러가 화면에 그릴 때 개별 요청).
 * 이전엔 씬마다 썸네일 BLOB을 읽어 base64로 만들어 응답에 실었는데, better-sqlite3가 동기라
 * 프리셋 전체를 한 번에 인코딩하는 동안 메인 프로세스가 통째로 멈췄다 (N9) — COUNT/EXISTS만 남겨 가볍게.
 */
const SCENE_SELECT = `SELECT s.id, s.preset_id, s.name, s.prompt, s.negative_prompt, s.width, s.height, s.reserve_count, s.reserve_json,
              (SELECT COUNT(*) FROM images WHERE scene_id = s.id) AS image_count,
              EXISTS(SELECT 1 FROM images WHERE scene_id = s.id AND favorite = 1) AS has_favorite
       FROM gen_scenes s`

type SceneRow = Row & {
  image_count: number
  has_favorite: number
}

/** 씬 카드 썸네일 1장 — nais-image 프로토콜이 요청 시점에 조회 (목록 조회에선 절대 읽지 않음) */
export function sceneThumbnail(sceneId: number): Buffer | null {
  const row = getDb()
    .prepare(
      'SELECT thumbnail FROM images WHERE scene_id = ? ORDER BY favorite DESC, id DESC LIMIT 1'
    )
    .get(sceneId) as { thumbnail: Buffer | null } | undefined
  return row?.thumbnail ?? null
}

export function listScenes(presetId: number): Scene[] {
  // 카드 썸네일: 즐겨찾기가 있으면 최상단(최신) 즐겨찾기, 없으면 최신 이미지 (NAIS2 방식)
  const rows = getDb()
    .prepare(`${SCENE_SELECT} WHERE s.preset_id = ? ORDER BY s.sort_order, s.id`)
    .all(presetId) as SceneRow[]
  return rows.map(toScene)
}

/**
 * 지정한 씬들만 경량 재조회 — 즐겨찾기 토글/생성 완료처럼 씬 몇 개만 바뀌었을 때
 * 프리셋 전체(수백 개 썸네일 BLOB)를 다시 읽지 않기 위함. better-sqlite3는 동기라
 * listScenes를 프리셋 전체에 매번 돌리면 메인 프로세스가 그만큼 멈춘다.
 */
export function sceneSummaries(ids: number[]): Scene[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`${SCENE_SELECT} WHERE s.id IN (${placeholders})`)
    .all(...ids) as SceneRow[]
  return rows.map(toScene)
}

/**
 * 씬 프리셋 순서 + 폴더 소속 변경 (캐릭터/조각과 같은 리스트 순서 모델).
 * 폴더 소속이 바뀐 프리셋은 저장 폴더도 실제로 이동한다 — 하나라도 실패하면
 * (경로 충돌 등) 이미 이동한 것들을 롤백하고 예외를 던져 순서 자체를 반영하지 않는다.
 */
export function reorderPresets(order: ScenePresetOrderEntry[]): void {
  const db = getDb()
  const before = new Map(
    (
      db.prepare('SELECT id, folder_id, name FROM scene_presets').all() as {
        id: number
        folder_id: number | null
        name: string
      }[]
    ).map((p) => [p.id, p])
  )
  const folderNames = new Map(
    (
      db.prepare('SELECT id, name FROM scene_preset_folders').all() as {
        id: number
        name: string
      }[]
    ).map((f) => [f.id, f.name])
  )

  let currentFolder: number | null = null
  const targetFolder = new Map<number, number | null>()
  for (const entry of order) {
    if (entry.type === 'folder') currentFolder = entry.id
    else targetFolder.set(entry.id, currentFolder)
  }

  const moved: {
    id: number
    oldFolderName: string | null
    newFolderName: string | null
    name: string
  }[] = []
  try {
    for (const [id, newFolderId] of targetFolder) {
      const prev = before.get(id)
      if (!prev || prev.folder_id === newFolderId) continue
      const oldFolderName = prev.folder_id != null ? (folderNames.get(prev.folder_id) ?? null) : null
      const newFolderName = newFolderId != null ? (folderNames.get(newFolderId) ?? null) : null
      movePresetDirectory(id, oldFolderName, prev.name, newFolderName, prev.name)
      moved.push({ id, oldFolderName, newFolderName, name: prev.name })
    }
  } catch (e) {
    for (const m of moved.reverse()) {
      try {
        movePresetDirectory(m.id, m.newFolderName, m.name, m.oldFolderName, m.name)
      } catch {
        // best-effort 롤백
      }
    }
    throw e
  }

  const setFolder = db.prepare('UPDATE scene_preset_folders SET sort_order = ? WHERE id = ?')
  const setPreset = db.prepare(
    'UPDATE scene_presets SET sort_order = ?, folder_id = ? WHERE id = ?'
  )
  db.transaction(() => {
    let cur: number | null = null
    order.forEach((entry, i) => {
      if (entry.type === 'folder') {
        cur = entry.id
        setFolder.run(i, entry.id)
      } else {
        setPreset.run(i, cur, entry.id)
      }
    })
  })()
}

/** 씬 저장 폴더 계층용 프리셋 이름 */
export function getPresetName(id: number): string | null {
  const r = getDb().prepare('SELECT name FROM scene_presets WHERE id = ?').get(id) as
    { name: string } | undefined
  return r?.name ?? null
}

export function getScene(id: number): Scene | null {
  const r = getDb()
    .prepare(
      `SELECT id, preset_id, name, prompt, negative_prompt, width, height, reserve_count, reserve_json,
              (SELECT COUNT(*) FROM images WHERE scene_id = ?) AS image_count
       FROM gen_scenes WHERE id = ?`
    )
    .get(id, id) as (Row & { image_count: number }) | undefined
  return r ? toScene(r) : null
}

/** 씬의 실제 저장 폴더 경로 (폴더 소속 반영) — 없으면 null */
function scenePathOf(sceneId: number): string | null {
  const scene = getScene(sceneId)
  if (!scene) return null
  const presetPath = getPresetPath(scene.presetId)
  return sceneDir(presetPath?.folderName ?? null, presetPath?.name ?? null, scene.name, scene.id)
}

const EXTERNAL_IMAGE_EXTS = new Set(['.png', '.webp', '.jpg', '.jpeg'])

/** 동시에 돌릴 sharp 썸네일 생성 수 (libuv 기본 스레드풀 크기에 맞춤) */
const THUMB_CONCURRENCY = 4

/**
 * 씬 폴더를 스캔해 DB에 없는 파일(탐색기로 직접 넣은 이미지 등)을 자동 등록한다.
 * seed/생성 payload 없이 kind='scene'으로만 넣는다 — 메타데이터 재현은 안 되지만 목록엔 뜬다.
 * limit: 한 번에 처리할 최대 파일 수 — NAIS2 등에서 대량 이관된 폴더(수십~수백 장)에서
 * 무한정 시간이 걸리는 걸 막는 안전장치. 남은 건 다음 호출(재감지·재클릭)에서 마저 처리된다.
 */
export async function syncSceneImages(
  sceneId: number,
  limit = 500
): Promise<{ added: number; lastFilePath: string | null }> {
  const dir = scenePathOf(sceneId)
  if (!dir || !existsSync(dir)) return { added: 0, lastFilePath: null }

  const db = getDb()
  const known = new Set(
    (
      db.prepare('SELECT file_path FROM images WHERE scene_id = ?').all(sceneId) as {
        file_path: string
      }[]
    ).map((r) => r.file_path)
  )
  // payload_json은 NOT NULL 컬럼 — 외부 파일은 생성 메타데이터가 없으니 빈 객체로
  const insert = db.prepare(
    `INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id)
     VALUES (?, ?, 'scene', NULL, '{}', ?)`
  )

  // 대상 파일을 먼저 추린 뒤 썸네일 생성만 병렬로 돌린다. sharp는 libuv 스레드풀에서
  // 도는 비동기 작업이라 한 장씩 await 하면 코어를 하나만 쓰고 그만큼 오래 걸린다.
  // DB 삽입은 better-sqlite3가 동기라 배치가 끝난 뒤 순차로.
  const targets: string[] = []
  for (const f of readdirSync(dir)) {
    if (targets.length >= limit) break
    const ext = extname(f).toLowerCase()
    if (!EXTERNAL_IMAGE_EXTS.has(ext)) continue
    const filePath = join(dir, f)
    if (known.has(filePath)) continue
    try {
      if (!statSync(filePath).isFile()) continue
    } catch {
      continue // 스캔 도중 사라진 파일 등
    }
    targets.push(filePath)
  }

  let added = 0
  let lastFilePath: string | null = null
  for (let i = 0; i < targets.length; i += THUMB_CONCURRENCY) {
    const batch = targets.slice(i, i + THUMB_CONCURRENCY)
    const thumbs = await Promise.all(
      batch.map((filePath) =>
        sharp(filePath)
          .resize(640, 640, { fit: 'inside' })
          .webp({ quality: 90 })
          .toBuffer()
          .catch(() => null) // 손상/미지원 파일은 건너뜀
      )
    )
    for (let j = 0; j < batch.length; j++) {
      const thumbnail = thumbs[j]
      if (!thumbnail) continue
      insert.run(batch[j], thumbnail, sceneId)
      added++
      lastFilePath = batch[j]
    }
  }
  return { added, lastFilePath }
}

/**
 * 프리셋의 모든 씬을 한 번에 동기화 (씬 목록 상단 "동기화" 버튼).
 * 씬마다 perSceneLimit만큼만 처리 — 씬이 많거나 씬당 대량 이관분이 있어도
 * 한 번의 클릭이 지나치게 오래 걸리지 않게 한다. 남은 건 다시 눌러서 마저.
 */
export async function syncPresetScenes(
  presetId: number,
  perSceneLimit = 50
): Promise<{ added: number }> {
  const ids = (
    getDb().prepare('SELECT id FROM gen_scenes WHERE preset_id = ?').all(presetId) as {
      id: number
    }[]
  ).map((r) => r.id)
  let added = 0
  for (const id of ids) {
    added += (await syncSceneImages(id, perSceneLimit)).added
  }
  return { added }
}

let activeWatcher: FSWatcher | null = null
let activeWatchSceneId: number | null = null

/**
 * 지금 열린 씬 하나만 실시간 감시 — 폴더에 파일이 "새로 추가"되는 것만 감지해 자동 동기화.
 * sceneId=null이면 감시 해제만. NAIS2 등에서 대량 이관된 기존 파일까지 열 때마다 훑으면
 * (수십~수백 장) 씬 상세 진입 자체가 느려지므로, 감시 시작 시점엔 스캔하지 않는다 — 이미
 * 있던 파일은 syncSceneImages를 사용자가 직접(동기화 버튼) 부를 때만 반영한다.
 */
export function watchScene(
  sceneId: number | null,
  onChange: (sceneId: number, filePath: string) => void
): void {
  if (activeWatcher) {
    activeWatcher.close()
    activeWatcher = null
    activeWatchSceneId = null
  }
  if (sceneId == null) return
  const dir = scenePathOf(sceneId)
  if (!dir || !existsSync(dir)) return
  activeWatchSceneId = sceneId

  let timer: ReturnType<typeof setTimeout> | undefined
  const sync = (): void => {
    // 실시간 감시는 "지금 막 추가된 소수 파일"만 노림 — 한 번에 20장 넘게 처리하지 않는다
    void syncSceneImages(sceneId, 20).then(({ added, lastFilePath }) => {
      if (added > 0 && lastFilePath && activeWatchSceneId === sceneId) {
        onChange(sceneId, lastFilePath)
      }
    })
  }
  try {
    activeWatcher = watch(dir, () => {
      clearTimeout(timer)
      timer = setTimeout(sync, 400) // 파일 복사 중 연속 이벤트 방지용 디바운스
    })
  } catch {
    // 폴더 삭제·권한 등으로 watch 실패 — 조용히 포기 (수동 새로고침/동기화로 대체 가능)
  }
}

export function createScene(presetId: number, name: string): number {
  const db = getDb()
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM gen_scenes WHERE preset_id = ?')
    .get(presetId) as { m: number }
  // 프리셋 기본 해상도 적용 (미설정 시 832×1216)
  const preset = db
    .prepare('SELECT default_width AS w, default_height AS h FROM scene_presets WHERE id = ?')
    .get(presetId) as { w: number | null; h: number | null } | undefined
  return Number(
    db
      .prepare(
        'INSERT INTO gen_scenes (preset_id, name, width, height, sort_order) VALUES (?, ?, ?, ?, ?)'
      )
      .run(presetId, name, preset?.w ?? 832, preset?.h ?? 1216, max.m + 1).lastInsertRowid
  )
}

/**
 * afterSortOrder보다 큰 씬을 전부 1칸씩 뒤로 밀어 그 바로 뒤에 끼워 넣을 자리를 만든다.
 * sort_order가 연속값이 아니어도(과거 append로 생긴 큰 간격 등) 상대 순서만 지키면
 * 되므로 문제없다 — 밀린 뒤의 최솟값보다 항상 작은 afterSortOrder+1로 삽입하면 된다.
 */
function makeRoomAfter(db: ReturnType<typeof getDb>, presetId: number, afterSortOrder: number): void {
  db.prepare('UPDATE gen_scenes SET sort_order = sort_order + 1 WHERE preset_id = ? AND sort_order > ?')
    .run(presetId, afterSortOrder)
}

/** 지정한 씬 바로 뒤에 빈 씬 생성 — 우클릭 "옆에 새 씬 생성" */
export function createSceneAfter(afterId: number, name: string): number {
  const db = getDb()
  const after = db.prepare('SELECT preset_id, sort_order FROM gen_scenes WHERE id = ?').get(afterId) as
    | { preset_id: number; sort_order: number }
    | undefined
  if (!after) return 0
  const preset = db
    .prepare('SELECT default_width AS w, default_height AS h FROM scene_presets WHERE id = ?')
    .get(after.preset_id) as { w: number | null; h: number | null } | undefined
  return db.transaction(() => {
    makeRoomAfter(db, after.preset_id, after.sort_order)
    return Number(
      db
        .prepare(
          'INSERT INTO gen_scenes (preset_id, name, width, height, sort_order) VALUES (?, ?, ?, ?, ?)'
        )
        .run(after.preset_id, name, preset?.w ?? 832, preset?.h ?? 1216, after.sort_order + 1)
        .lastInsertRowid
    )
  })()
}

/** 원본 씬 바로 뒤에 복제본 생성 — 목록 끝이 아니라 원본 옆에서 바로 보이도록 */
export function duplicateScene(id: number): number {
  const db = getDb()
  const s = db.prepare('SELECT * FROM gen_scenes WHERE id = ?').get(id) as
    | (Row & { sort_order: number })
    | undefined
  if (!s) return 0
  return db.transaction(() => {
    makeRoomAfter(db, s.preset_id, s.sort_order)
    return Number(
      db
        .prepare(
          `INSERT INTO gen_scenes (preset_id, name, prompt, negative_prompt, width, height, sort_order, reserve_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
          s.preset_id,
          `${s.name} 복제`,
          s.prompt,
          s.negative_prompt,
          s.width,
          s.height,
          s.sort_order + 1
        ).lastInsertRowid
    )
  })()
}

const FIELDS: Record<string, string> = {
  name: 'name',
  prompt: 'prompt',
  negativePrompt: 'negative_prompt',
  width: 'width',
  height: 'height',
  reserveCount: 'reserve_count'
}

export function updateScene(id: number, patch: Record<string, unknown>): void {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, col] of Object.entries(FIELDS)) {
    if (patch[key] === undefined) continue
    sets.push(`${col} = ?`)
    values.push(patch[key])
  }
  if (sets.length === 0) return
  sets.push(`updated_at = datetime('now')`)
  getDb()
    .prepare(`UPDATE gen_scenes SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id)
}

export function deleteScene(id: number): void {
  getDb().prepare('DELETE FROM gen_scenes WHERE id = ?').run(id)
}

export function reorderScenes(ids: number[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE gen_scenes SET sort_order = ? WHERE id = ?')
  db.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))()
}

/**
 * 예약된(reserve_count > 0) 씬만 전 프리셋 통틀어 한 번에 조회 — 썸네일 서브쿼리 없이.
 * generateReserved()가 프리셋마다 무거운 listScenes(썸네일 포함)를 순차 호출하던 것을
 * 대체 — 예약 스캔에 썸네일은 필요 없다. N번 왕복 → 1번, 비용도 예약된 씬 수에만 비례 (N8)
 */
export function reservedScenes(): Scene[] {
  const rows = getDb()
    .prepare(
      `SELECT id, preset_id, name, prompt, negative_prompt, width, height, reserve_count, reserve_json
       FROM gen_scenes WHERE reserve_count > 0 ORDER BY preset_id, sort_order, id`
    )
    .all() as Row[]
  return rows.map((r) => toScene({ ...r, image_count: 0 }))
}

/** 예약된 씬 전체(전 프리셋)를 한 번에 초기화 — 프리셋별 setReserveAll 순차 호출 대체 (N8) */
export function clearAllReserves(): void {
  getDb()
    .prepare('UPDATE gen_scenes SET reserve_count = 0, reserve_json = NULL WHERE reserve_count > 0')
    .run()
}

/** 프리셋 내 전체 씬 예약 수를 count로 설정 (전체 취소 0 등) */
export function setReserveAll(presetId: number, count: number): void {
  // 절대값 설정은 전체 취소(0) 용도 — 출연 내역도 함께 초기화
  getDb()
    .prepare('UPDATE gen_scenes SET reserve_count = ?, reserve_json = NULL WHERE preset_id = ?')
    .run(count, presetId)
}

/** 모든 프리셋의 예약 총합 */
export function reservedTotal(): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(reserve_count), 0) AS t FROM gen_scenes')
    .get() as { t: number }
  return row.t
}

/** 프리셋 내 전체 씬 예약 수를 delta만큼 증감 (최소 0) */
export function adjustReserveAll(presetId: number, castId: string, delta: number): void {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, reserve_json FROM gen_scenes WHERE preset_id = ?')
    .all(presetId) as { id: number; reserve_json: string | null }[]
  const tx = db.transaction(() => {
    for (const row of rows) {
      const reserves = parseReserves(row.reserve_json)
      reserves[castId] = Math.max(0, (reserves[castId] ?? 0) + delta)
      setSceneReserves(row.id, reserves)
    }
  })
  tx()
}

// ── 편집 모드 일괄 작업 ──────────────────────────────────
function placeholders(n: number): string {
  return Array(n).fill('?').join(',')
}

export function bulkMove(ids: number[], presetId: number): void {
  if (ids.length === 0) return
  getDb()
    .prepare(`UPDATE gen_scenes SET preset_id = ? WHERE id IN (${placeholders(ids.length)})`)
    .run(presetId, ...ids)
}

export function bulkDelete(ids: number[]): void {
  if (ids.length === 0) return
  getDb()
    .prepare(`DELETE FROM gen_scenes WHERE id IN (${placeholders(ids.length)})`)
    .run(...ids)
}

export function bulkSetResolution(ids: number[], width: number, height: number): void {
  if (ids.length === 0) return
  getDb()
    .prepare(
      `UPDATE gen_scenes SET width = ?, height = ? WHERE id IN (${placeholders(ids.length)})`
    )
    .run(width, height, ...ids)
}

export function bulkClearFavorites(ids: number[]): void {
  if (ids.length === 0) return
  getDb()
    .prepare(`UPDATE images SET favorite = 0 WHERE scene_id IN (${placeholders(ids.length)})`)
    .run(...ids)
}

/**
 * 파일 여러 개 삭제 — 동시 개수를 제한한 비동기 삭제.
 * unlinkSync 루프는 삭제 수에 그대로 비례해 메인 프로세스를 세운다 (수백 장이면 체감 정지).
 * 이미 없는 파일은 무시한다 (best-effort).
 */
const UNLINK_CONCURRENCY = 16

async function unlinkAll(paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += UNLINK_CONCURRENCY) {
    await Promise.all(paths.slice(i, i + UNLINK_CONCURRENCY).map((p) => unlink(p).catch(() => {})))
  }
}

/** 선택 씬들의 생성 이미지를 전부 삭제 (DB 행 + 파일). 대량이라 파일은 best-effort */
export async function bulkClearImages(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const db = getDb()
  const rows = db
    .prepare(`SELECT file_path FROM images WHERE scene_id IN (${placeholders(ids.length)})`)
    .all(...ids) as { file_path: string }[]
  db.prepare(`DELETE FROM images WHERE scene_id IN (${placeholders(ids.length)})`).run(...ids)
  await unlinkAll(rows.map((r) => r.file_path))
  return rows.length
}

// ── 씬 상세 이미지 (페이지네이션) ────────────────────────
export function sceneImages(
  sceneId: number,
  limit: number,
  offset: number,
  favoritesOnly?: boolean
): { items: SceneImage[]; total: number } {
  const db = getDb()
  const fav = favoritesOnly ? ' AND favorite = 1' : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM images WHERE scene_id = ?${fav}`).get(sceneId) as {
      c: number
    }
  ).c
  // thumbnail BLOB은 읽지 않는다 — 씬 상세 그리드는 원본을 nais-image://…?path=로
  // 지연 로드하므로 썸네일을 쓰지 않는데, 예전엔 한 페이지(80장) 분량을 base64로 만들어
  // IPC로 넘겼다: 80 × 평균 46KB × 1.33 ≈ 2.1MB를 매 페이지·매 재로드마다 낭비 (N9와 같은 실수)
  const rows = db
    .prepare(
      `SELECT id, file_path, seed, favorite FROM images
       WHERE scene_id = ?${fav} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(sceneId, limit, offset) as {
    id: number
    file_path: string
    seed: number | null
    favorite: number
  }[]
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      seed: r.seed,
      favorite: r.favorite === 1
    }))
  }
}

/** 씬의 즐겨찾기 제외 전체 삭제 (파일 포함) — 반환: 삭제 수 (N5) */
export async function deleteNonFavorites(sceneId: number): Promise<number> {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, file_path FROM images WHERE scene_id = ? AND favorite = 0')
    .all(sceneId) as { id: number; file_path: string }[]
  db.prepare('DELETE FROM images WHERE scene_id = ? AND favorite = 0').run(sceneId)
  // DB 행을 먼저 지우고 파일 삭제를 await 한다 — 삭제가 끝나기 전에 응답하면 열린 씬의
  // 폴더 감시(watchScene)가 "DB에 없는데 디스크엔 있는 파일"로 보고 도로 등록해버린다.
  await unlinkAll(rows.map((r) => r.file_path))
  return rows.length
}

export function setImageFavorite(id: number, favorite: boolean): void {
  getDb()
    .prepare('UPDATE images SET favorite = ? WHERE id = ?')
    .run(favorite ? 1 : 0, id)
}

/** 앱 내부 라이브러리(자동 저장 OFF 보관소) 파일인지 — 유저 저장 폴더 파일은 보존 대상 */
function isInternalFile(filePath: string): boolean {
  const rel = relative(libraryRoot(), filePath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function unlinkIfInternal(filePath: string): void {
  if (!isInternalFile(filePath)) return
  try {
    unlinkSync(filePath)
  } catch {
    // 무시
  }
}

/** 히스토리 전체 비우기 — 기록만 삭제, 파일 보존 (내부 라이브러리 파일은 정리) */
export async function clearAllImages(): Promise<number> {
  const db = getDb()
  const rows = db.prepare('SELECT file_path FROM images').all() as { file_path: string }[]
  db.prepare('DELETE FROM images').run()
  await unlinkAll(rows.map((r) => r.file_path).filter(isInternalFile))
  return rows.length
}

/**
 * 이미지 삭제.
 * - deleteFile=true: 파일까지 삭제 (씬 상세의 명시적 삭제)
 * - deleteFile=false: 기록만 삭제, 파일 보존 (히스토리 삭제 — 내부 라이브러리 파일만 정리)
 */
export function deleteImage(id: number, deleteFile: boolean): void {
  const db = getDb()
  const r = db.prepare('SELECT file_path FROM images WHERE id = ?').get(id) as
    { file_path: string } | undefined
  db.prepare('DELETE FROM images WHERE id = ?').run(id)
  if (!r) return
  if (isMemoryPath(r.file_path)) {
    dropMemoryImage(r.file_path)
    return
  }
  if (deleteFile) {
    try {
      unlinkSync(r.file_path)
    } catch {
      // 무시
    }
  } else {
    unlinkIfInternal(r.file_path)
  }
}

// ── JSON / ZIP ──────────────────────────────────────────
export async function exportScenesJson(presetId: number): Promise<boolean> {
  const scenes = getDb()
    .prepare(
      'SELECT name, prompt, negative_prompt, width, height FROM gen_scenes WHERE preset_id = ? ORDER BY sort_order, id'
    )
    .all(presetId) as Row[]
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: '씬 내보내기',
    defaultPath: 'nais3-scenes.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return false
  const data = scenes.map((s) => ({
    name: s.name,
    prompt: s.prompt,
    negativePrompt: s.negative_prompt,
    width: s.width,
    height: s.height
  }))
  writeFileSync(result.filePath, JSON.stringify({ version: 1, scenes: data }, null, 2), 'utf-8')
  return true
}

export async function importScenesJson(presetId: number): Promise<number> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '씬 불러오기',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return 0
  const parsed = JSON.parse(readFileSync(result.filePaths[0], 'utf-8')) as {
    scenes?: {
      name?: string
      prompt?: string
      /** NAIS2 씬 내보내기(JSON) 포맷의 프롬프트 필드명 */
      scenePrompt?: string
      negativePrompt?: string
      width?: number
      height?: number
    }[]
  }
  const scenes = parsed.scenes ?? []
  const db = getDb()
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM gen_scenes WHERE preset_id = ?')
    .get(presetId) as { m: number }
  let order = max.m
  const stmt = db.prepare(
    'INSERT INTO gen_scenes (preset_id, name, prompt, negative_prompt, width, height, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  db.transaction(() => {
    for (const s of scenes) {
      stmt.run(
        presetId,
        s.name ?? '씬',
        s.prompt ?? s.scenePrompt ?? '', // NAIS2 파일은 scenePrompt
        s.negativePrompt ?? '',
        s.width ?? 832,
        s.height ?? 1216,
        ++order
      )
    }
  })()
  return scenes.length
}

type ZipEntry = { file_path: string; name: string }

async function zipFiles(entries: ZipEntry[], defaultName: string): Promise<number> {
  if (entries.length === 0) return 0
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: 'ZIP 내보내기',
    defaultPath: defaultName,
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return 0
  const zip = new JSZip()
  const used = new Set<string>()
  for (const e of entries) {
    try {
      let name = e.name
      while (used.has(name)) name = `_${name}` // 동명 씬 충돌 폴백
      used.add(name)
      zip.file(name, readFileSync(e.file_path))
    } catch {
      // 파일 없으면 건너뜀
    }
  }
  writeFileSync(result.filePath, await zip.generateAsync({ type: 'nodebuffer' }))
  return used.size
}

/**
 * 씬별 내보낼 이미지 선정 + 이름 (NAIS2 ExportDialog와 동일):
 * 즐겨찾기가 있으면 즐겨찾기 전부, 없으면 최상단(썸네일=최신) 1장.
 * 이름은 씬 이름 그대로 — 한 씬에서 여러 장(즐겨찾기 다수)일 때만 _1, _2 접미사.
 */
function zipEntriesForScenes(sceneIds: number[]): ZipEntry[] {
  const db = getDb()
  const entries: ZipEntry[] = []
  for (const sceneId of sceneIds) {
    const scene = db.prepare('SELECT name FROM gen_scenes WHERE id = ?').get(sceneId) as
      { name: string } | undefined
    if (!scene) continue
    const favorites = db
      .prepare('SELECT file_path FROM images WHERE scene_id = ? AND favorite = 1 ORDER BY id DESC')
      .all(sceneId) as { file_path: string }[]
    const picks =
      favorites.length > 0
        ? favorites
        : (db
            .prepare('SELECT file_path FROM images WHERE scene_id = ? ORDER BY id DESC LIMIT 1')
            .all(sceneId) as { file_path: string }[])
    const safe = scene.name.replace(/[/\\:*?"<>|]/g, '_').trim() || `씬-${sceneId}`
    picks.forEach((p, i) => {
      const suffix = picks.length > 1 ? `_${i + 1}` : ''
      entries.push({
        file_path: p.file_path,
        name: `${safe}${suffix}${extname(p.file_path) || '.png'}`
      })
    })
  }
  return entries
}

/** 활성 프리셋의 씬들을 ZIP으로 (NAIS2 방식 — 즐겨찾기 우선, 없으면 최상단 1장) */
export async function exportZip(presetId: number): Promise<number> {
  const sceneIds = (
    getDb()
      .prepare('SELECT id FROM gen_scenes WHERE preset_id = ? ORDER BY sort_order, id')
      .all(presetId) as { id: number }[]
  ).map((r) => r.id)
  const presetName = (getPresetName(presetId) ?? '씬').replace(/[/\\:*?"<>|]/g, '_')
  return zipFiles(zipEntriesForScenes(sceneIds), `${presetName}_${Date.now()}.zip`)
}

/** 선택한 씬들을 ZIP으로 — 선정/이름 규칙은 전체 내보내기와 동일 */
export async function bulkExportZip(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  return zipFiles(zipEntriesForScenes(ids), `scenes_${Date.now()}.zip`)
}
