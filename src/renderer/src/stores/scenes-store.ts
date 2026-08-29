import { create } from 'zustand'
import { recordNav } from '../lib/nav-history'
import type {
  GenerationRequest,
  ListFolder,
  Scene,
  SceneCast,
  SceneImage,
  ScenePreset,
  ScenePresetOrderEntry
} from '@shared/types'
import { canonicalize, moveRow } from '../lib/folder-list'
import { enabledCharacters, useCharactersStore } from './characters-store'
import { randomSeed, useGenerationStore } from './generation-store'
import { toast } from './toast-store'

/** chars/frags 등의 toOrderEntries와 같은 모델이지만 항목 타입 라벨이 'preset' */
function toPresetOrderEntries(
  folders: ListFolder[],
  items: ScenePreset[]
): ScenePresetOrderEntry[] {
  const order: ScenePresetOrderEntry[] = []
  for (const p of items.filter((p) => p.folderId == null)) order.push({ type: 'preset', id: p.id })
  for (const f of folders) {
    order.push({ type: 'folder', id: f.id })
    for (const p of items.filter((p) => p.folderId === f.id)) order.push({ type: 'preset', id: p.id })
  }
  return order
}

const PAGE = 80 // 씬 상세 이미지 페이지 크기 (수만 장 대비: 한 번에 전부 로드 금지)
let loadSeq = 0 // load() 비동기 응답 순서 보장용
let imagesSeq = 0 // loadImages() 비동기 응답 순서 보장용
let selectionAnchor: number | null = null // 쉬프트 범위 선택 기준점 (마지막 일반 클릭 씬)

interface ScenesState {
  presets: ScenePreset[]
  presetFolders: ListFolder[]
  activePresetId: number
  scenes: Scene[]
  selectedId: number | null // 상세로 연 씬
  editMode: boolean
  selection: Set<number> // 편집 모드 체크된 씬들
  columns: number // 2~5
  cardOrientation: 'portrait' | 'landscape' | 'square' // 카드 비율 고정 (해상도 무관)

  // 상세 이미지 (페이지네이션)
  images: SceneImage[]
  imagesTotal: number
  imagesLoading: boolean
  /** 씬 상세 "즐겨찾기만 보기" 필터 (N4) */
  favoritesOnly: boolean

  loadPresets: () => Promise<void>
  setActivePreset: (id: number) => Promise<void>
  createPreset: (name: string, folderId?: number | null) => Promise<void>
  renamePreset: (id: number, name: string) => Promise<void>
  deletePreset: (id: number) => Promise<void>
  /** 프리셋/폴더 드래그 정렬 — 폴더 소속이 바뀌면 저장 폴더도 실제로 이동(실패 시 되돌리고 토스트) */
  movePreset: (activeKey: string, overKey: string) => Promise<void>
  createPresetFolder: (name: string) => Promise<void>
  renamePresetFolder: (id: number, name: string) => Promise<void>
  togglePresetFolderCollapse: (id: number) => void
  setPresetFolderColor: (id: number, color: string | null) => void
  removePresetFolder: (id: number) => Promise<void>

  load: () => Promise<void>
  /** 지정한 씬들만 경량 재조회해 목록에 패치 — 즐겨찾기 토글/생성 완료처럼 일부만 바뀌었을 때 전체 reload(썸네일 전부 재조회) 대신 사용 */
  refreshScenes: (ids: number[]) => Promise<void>
  /** 새로 만든 씬 1개만 목록 끝에 붙임 — 생성/복제 후 프리셋 전체 reload 대신 */
  appendScene: (id: number) => Promise<void>
  select: (id: number | null) => void
  setEditMode: (v: boolean) => void
  setColumns: (n: number) => void
  setCardOrientation: (o: 'portrait' | 'landscape' | 'square') => void
  toggleSelected: (id: number) => void
  /** 쉬프트 클릭 — 마지막 클릭 씬과 이 씬 사이(양끝 포함)를 모두 선택 */
  rangeSelect: (id: number) => void
  selectAll: () => void
  clearSelection: () => void

  create: (name: string) => Promise<void>
  update: (id: number, patch: Partial<Scene>) => Promise<void>
  duplicate: (id: number) => Promise<void>
  remove: (id: number) => Promise<void>
  reorder: (ids: number[]) => Promise<void>
  /** 프리셋의 새 씬 기본 해상도 설정 (N3) */
  setPresetDefaultResolution: (id: number, width: number, height: number) => Promise<void>

  // 출연(Cast) — 예약에 붙는 캐릭터/레퍼런스 구성 ('' = 사이드바 설정)
  casts: SceneCast[]
  activeCastId: string
  setActiveCast: (id: string) => void
  addCast: (data: Pick<SceneCast, 'name' | 'characterIds' | 'charRefIds' | 'vibeIds'>) => void
  updateCast: (id: string, patch: Partial<SceneCast>) => void
  removeCast: (id: string) => void
  reorderCasts: (ids: string[]) => void

  // 예약
  /** 모든 프리셋의 예약 총합 — 좌측 "씬 생성 n장" 표시 (예약 수 = 생성 수) */
  reservedTotal: number
  refreshReservedTotal: () => Promise<void>
  adjustReserve: (id: number, delta: number) => Promise<void>
  /** 예약 수 직접 지정 — 배지 숫자를 클릭해 입력 (배치 단위 증감과 달리 입력값 그대로) */
  setReserve: (id: number, count: number) => Promise<void>
  adjustReserveAll: (delta: number) => Promise<void>
  clearReserveAll: () => Promise<void>

  // 편집 모드 일괄
  bulkMove: (presetId: number) => Promise<void>
  bulkDelete: () => Promise<void>
  bulkSetResolution: (width: number, height: number) => Promise<void>
  bulkClearFavorites: () => Promise<void>
  bulkClearImages: () => Promise<void>
  bulkExportZip: () => Promise<void>

  /** 완료 즉시 카드 썸네일을 새 원본으로 낙관적 갱신 (튐 방지) */
  setSceneThumb: (sceneId: number, filePath: string) => void
  loadImages: (sceneId: number, reset: boolean) => Promise<void>
  toggleFavorite: (imageId: number) => Promise<void>
  deleteImage: (imageId: number) => Promise<void>
  /** 즐겨찾기만 보기 토글 (N4) */
  setFavoritesOnly: (v: boolean) => void
  /** 즐겨찾기 제외 전체 삭제 (N5) */
  deleteNonFavorites: (sceneId: number) => Promise<number>
  /** 씬 폴더를 1회 스캔해 DB에 없는 파일(대량 이관분 등)을 등록 — 동기화 버튼 */
  syncScene: (sceneId: number) => Promise<void>
  /** 현재 프리셋의 모든 씬을 한 번에 동기화 — 씬 목록 상단 동기화 버튼 */
  syncActivePreset: () => Promise<void>

  /** 모든 프리셋의 예약을 프리셋 순서대로 전부 큐에 넣는다 (프리셋별 캐릭터 바인드 적용) */
  generateReserved: () => Promise<void>
  /** 프리셋 캐릭터 바인드 (null = 해제) */
  /** 이 씬 1장 바로 생성 (예약 없이 — NAIS2식 즉석 생성) */
  generateOne: (sceneId: number) => Promise<void>
}

/**
 * 씬 프롬프트를 기본 프롬프트 뒤에 이어붙임 — 항상 새 줄로.
 * 콤마로 이으면 기본 프롬프트 마지막 줄이 #주석이었을 때 씬 프롬프트가 그 줄에
 * 딸려 들어가 통째로 주석 처리(removeComments)돼 사라지는 버그가 있었다.
 */
export function appendPrompt(base: string, add: string): string {
  const b = base.trim().replace(/,\s*$/, '')
  const a = add.trim().replace(/^,\s*/, '')
  if (!b) return a
  if (!a) return b
  return `${b}\n${a}`
}

/**
 * 출연의 캐릭터 카드 해석 — 출연이 있으면 그 카드들(enabled 무시),
 * 사이드바 출연(null)이면 켜둔 캐릭터. 삭제된 카드 id는 건너뛴다.
 */
function resolveCharacters(cast: SceneCast | null): ReturnType<typeof enabledCharacters> {
  if (!cast) return enabledCharacters()
  const byId = new Map(useCharactersStore.getState().items.map((c) => [c.id, c]))
  return cast.characterIds.map((id) => byId.get(id)).filter((c) => c != null)
}

/**
 * 씬 → 생성 요청. 사이드바의 모든 것(기본/네거 프롬프트·캐릭터·조각·바이브·레퍼런스·
 * 파라미터)을 그대로 쓰고, 씬 프롬프트는 기본/네거 프롬프트 "뒤에 이어붙인다".
 * 해상도만 씬 것을 사용 (소스가 있으면 소스 해상도가 우선). 바이브/레퍼런스/조각은
 * 메인 프로세스가 DB·와일드카드에서 읽어 적용하므로 여기선 프롬프트·캐릭터·파라미터만 구성.
 * 출연 예약이면 캐릭터/바이브/캐릭레퍼를 출연 구성으로 완전 교체 (사이드바 무시).
 */
function buildSceneRequest(scene: Scene, cast: SceneCast | null): GenerationRequest {
  const base = useGenerationStore.getState().request
  const src = useGenerationStore.getState().source
  // 3분할 꺼진 상태면 promptParts를 요청/메타데이터에 싣지 않는다
  const splitEnabled = useGenerationStore.getState().promptSplitEnabled
  const characterPrompts = resolveCharacters(cast).map((c) => ({
    prompt: c.prompt,
    negativePrompt: c.negativePrompt,
    center: c.center,
    enabled: true as const
  }))
  return {
    ...base,
    prompt: appendPrompt(base.prompt, scene.prompt),
    promptParts:
      splitEnabled && base.promptParts
        ? { ...base.promptParts, detail: appendPrompt(base.promptParts.detail, scene.prompt) }
        : undefined,
    negativePrompt: appendPrompt(base.negativePrompt, scene.negativePrompt),
    width: src ? src.width : scene.width,
    height: src ? src.height : scene.height,
    characterPrompts,
    // 출연 예약이면 바이브/캐릭레퍼도 출연 것으로 (빈 배열 = 없이 생성)
    ...(cast ? { vibeIds: cast.vibeIds, charRefIds: cast.charRefIds } : {}),
    sceneId: scene.id,
    source: src
      ? {
          imageBase64: src.imageBase64,
          maskBase64: src.maskBase64,
          strength: base.i2iStrength ?? 0.7,
          noise: base.i2iNoise ?? 0
        }
      : undefined
  }
}

export const useScenesStore = create<ScenesState>((set, get) => ({
  presets: [],
  presetFolders: [],
  activePresetId: 1,
  scenes: [],
  selectedId: null,
  editMode: false,
  selection: new Set(),
  columns: Number(localStorage.getItem('scene_columns')) || 3,
  cardOrientation:
    (localStorage.getItem('scene_orientation') as 'portrait' | 'landscape' | 'square') ||
    'portrait',
  images: [],
  imagesTotal: 0,
  imagesLoading: false,
  favoritesOnly: false,

  loadPresets: async () => {
    const { folders, items } = await window.nais.invoke('scenePresets:list', undefined)
    set({ presetFolders: folders, presets: canonicalize(folders, items) })
    if (!items.some((p) => p.id === get().activePresetId) && items[0]) {
      set({ activePresetId: items[0].id })
    }
    await get().load()
  },
  setActivePreset: async (id) => {
    selectionAnchor = null
    set({ activePresetId: id, selectedId: null, selection: new Set() })
    await get().load()
  },
  createPreset: async (name, folderId = null) => {
    const { id } = await window.nais.invoke('scenePresets:create', { name, folderId })
    await get().loadPresets()
    await get().setActivePreset(id)
  },
  renamePreset: async (id, name) => {
    set({ presets: get().presets.map((p) => (p.id === id ? { ...p, name } : p)) })
    await window.nais.invoke('scenePresets:rename', { id, name })
  },
  deletePreset: async (id) => {
    await window.nais.invoke('scenePresets:delete', { id })
    await get().loadPresets()
  },
  movePreset: async (activeKey, overKey) => {
    const { presetFolders, presets } = get()
    const prevFolders = presetFolders
    const prevPresets = presets
    const next = moveRow(presetFolders, presets, activeKey, overKey)
    set({ presetFolders: next.folders, presets: next.items })
    try {
      await window.nais.invoke('scenePresets:reorder', {
        order: toPresetOrderEntries(next.folders, next.items)
      })
    } catch (e) {
      set({ presetFolders: prevFolders, presets: prevPresets })
      toast(e instanceof Error ? e.message : '프리셋 이동에 실패했습니다', 'error')
    }
  },
  createPresetFolder: async (name) => {
    const { id } = await window.nais.invoke('scenePresets:folderCreate', { name })
    set({ presetFolders: [...get().presetFolders, { id, name, collapsed: false, color: null }] })
  },
  renamePresetFolder: async (id, name) => {
    const prev = get().presetFolders
    set({ presetFolders: prev.map((f) => (f.id === id ? { ...f, name } : f)) })
    try {
      await window.nais.invoke('scenePresets:folderRename', { id, name })
    } catch (e) {
      toast(e instanceof Error ? e.message : '폴더 이름 변경에 실패했습니다', 'error')
      await get().loadPresets()
    }
  },
  togglePresetFolderCollapse: (id) => {
    const folder = get().presetFolders.find((f) => f.id === id)
    if (!folder) return
    set({
      presetFolders: get().presetFolders.map((f) =>
        f.id === id ? { ...f, collapsed: !f.collapsed } : f
      )
    })
    void window.nais.invoke('scenePresets:folderCollapse', { id, collapsed: !folder.collapsed })
  },
  setPresetFolderColor: (id, color) => {
    set({ presetFolders: get().presetFolders.map((f) => (f.id === id ? { ...f, color } : f)) })
    void window.nais.invoke('scenePresets:folderColor', { id, color })
  },
  removePresetFolder: async (id) => {
    const prevFolders = get().presetFolders
    const prevPresets = get().presets
    const nextPresets = prevPresets.map((p) => (p.folderId === id ? { ...p, folderId: null } : p))
    const nextFolders = prevFolders.filter((f) => f.id !== id)
    set({ presetFolders: nextFolders, presets: canonicalize(nextFolders, nextPresets) })
    try {
      await window.nais.invoke('scenePresets:folderDelete', { id })
    } catch (e) {
      set({ presetFolders: prevFolders, presets: prevPresets })
      toast(e instanceof Error ? e.message : '폴더 삭제에 실패했습니다', 'error')
    }
  },
  setPresetDefaultResolution: async (id, width, height) => {
    set({
      presets: get().presets.map((p) =>
        p.id === id ? { ...p, defaultWidth: width, defaultHeight: height } : p
      )
    })
    await window.nais.invoke('scenePresets:setDefaultResolution', { id, width, height })
  },

  load: async () => {
    // 시퀀스 가드: 생성 중 scenes:changed가 연달아 오면 응답이 뒤섞여 옛 썸네일이 남을 수 있음
    const seq = ++loadSeq
    const presetId = get().activePresetId
    const { items } = await window.nais.invoke('scenes:list', { presetId })
    void get().refreshReservedTotal() // 예약 총합(전 프리셋)도 함께 갱신
    if (seq !== loadSeq || get().activePresetId !== presetId) return // 더 최신 로드가 있으면 폐기
    set({ scenes: items })
  },
  refreshScenes: async (ids) => {
    const uniq = [...new Set(ids)]
    if (uniq.length === 0) return
    const { items } = await window.nais.invoke('scenes:summaries', { ids: uniq })
    if (items.length === 0) return
    const byId = new Map(items.map((s) => [s.id, s]))
    set({ scenes: get().scenes.map((s) => byId.get(s.id) ?? s) })
  },
  appendScene: async (id) => {
    const presetId = get().activePresetId
    const { items } = await window.nais.invoke('scenes:summaries', { ids: [id] })
    const scene = items[0]
    // 프리셋을 갈아탄 뒤 응답이 오면 남의 목록에 끼워넣는 꼴 — 폐기
    if (!scene || get().activePresetId !== presetId || scene.presetId !== presetId) return
    if (get().scenes.some((s) => s.id === id)) return
    // 새 씬은 sort_order = MAX+1 (repo.createScene/duplicateScene) — 목록 정렬과 같게 맨 뒤
    set({ scenes: [...get().scenes, scene] })
  },
  select: (selectedId) => {
    if (selectedId !== get().selectedId) recordNav() // 마우스 뒤로/앞으로용 히스토리
    set({ selectedId, images: [], imagesTotal: 0, favoritesOnly: false })
    // 열린 씬 폴더를 실시간 감시 — 탐색기로 넣은 외부 이미지도 자동 반영 (scenes:changed로 알림)
    void window.nais.invoke('scenes:watch', { sceneId: selectedId })
    if (selectedId != null) void get().loadImages(selectedId, true)
  },
  setEditMode: (editMode) => {
    selectionAnchor = null
    set({ editMode, selection: new Set() })
  },
  setColumns: (columns) => {
    set({ columns })
    localStorage.setItem('scene_columns', String(columns))
  },
  setCardOrientation: (cardOrientation) => {
    set({ cardOrientation })
    localStorage.setItem('scene_orientation', cardOrientation)
  },
  toggleSelected: (id) => {
    const next = new Set(get().selection)
    next.has(id) ? next.delete(id) : next.add(id)
    selectionAnchor = id
    set({ selection: next })
  },
  rangeSelect: (id) => {
    const { scenes } = get()
    const from = scenes.findIndex((s) => s.id === selectionAnchor)
    const to = scenes.findIndex((s) => s.id === id)
    if (from === -1 || to === -1) {
      get().toggleSelected(id)
      return
    }
    const next = new Set(get().selection)
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(scenes[i].id)
    // 앵커는 유지 — 파일탐색기처럼 연속 쉬프트 클릭이 같은 기준점에서 범위를 다시 잡는다
    set({ selection: next })
  },
  selectAll: () => set({ selection: new Set(get().scenes.map((s) => s.id)) }),
  clearSelection: () => set({ selection: new Set() }),

  create: async (name) => {
    const { id } = await window.nais.invoke('scenes:create', {
      presetId: get().activePresetId,
      name
    })
    await get().appendScene(id)
  },
  update: async (id, patch) => {
    set({ scenes: get().scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
    await window.nais.invoke('scenes:update', {
      id,
      patch: {
        name: patch.name,
        prompt: patch.prompt,
        negativePrompt: patch.negativePrompt,
        width: patch.width,
        height: patch.height,
        reserveCount: patch.reserveCount
      }
    })
  },
  duplicate: async (id) => {
    const { id: newId } = await window.nais.invoke('scenes:duplicate', { id })
    if (newId > 0) await get().appendScene(newId)
  },
  remove: async (id) => {
    await window.nais.invoke('scenes:delete', { id })
    // 지운 씬만 목록에서 빼면 된다 — 프리셋 전체 재조회는 남은 카드 전부를 새 객체로
    // 갈아치워 불필요한 리렌더를 만든다 (씬 수백 개면 체감)
    set({
      scenes: get().scenes.filter((s) => s.id !== id),
      ...(get().selectedId === id ? { selectedId: null } : {})
    })
  },
  reorder: async (ids) => {
    set({ scenes: ids.map((id) => get().scenes.find((s) => s.id === id)!).filter(Boolean) })
    await window.nais.invoke('scenes:reorder', { ids })
  },

  reservedTotal: 0,
  refreshReservedTotal: async () => {
    const { total } = await window.nais.invoke('scenes:reservedTotal', undefined)
    set({ reservedTotal: total })
  },
  adjustReserve: async (id, delta) => {
    const scene = get().scenes.find((s) => s.id === id)
    if (!scene) return
    // 예약은 배치 생성 개수 단위로 (배치 3이면 +3/-3 — NAIS2 워크플로).
    // 현재 선택된 출연의 예약을 증감 — 예약이 "누구로 뽑을지"를 기억한다
    const castId = get().activeCastId
    const step = delta * (useGenerationStore.getState().batchCount || 1)
    const reserves = { ...scene.reserves }
    const next = Math.max(0, (reserves[castId] ?? 0) + step)
    if (next > 0) reserves[castId] = next
    else delete reserves[castId]
    const reserveCount = Object.values(reserves).reduce((a, b) => a + b, 0)
    set({
      scenes: get().scenes.map((s) => (s.id === id ? { ...s, reserves, reserveCount } : s))
    })
    await window.nais.invoke('scenes:setReserves', { id, reserves })
    void get().refreshReservedTotal()
  },
  setReserve: async (id, count) => {
    const scene = get().scenes.find((s) => s.id === id)
    if (!scene) return
    // 숫자를 직접 입력한 경우 — 배치 단위 증감이 아니라 입력값 그대로 (0이면 예약 해제)
    const castId = get().activeCastId
    const reserves = { ...scene.reserves }
    const next = Math.max(0, Math.min(9999, Math.floor(count)))
    if (next > 0) reserves[castId] = next
    else delete reserves[castId]
    const reserveCount = Object.values(reserves).reduce((a, b) => a + b, 0)
    set({
      scenes: get().scenes.map((s) => (s.id === id ? { ...s, reserves, reserveCount } : s))
    })
    await window.nais.invoke('scenes:setReserves', { id, reserves })
    void get().refreshReservedTotal()
  },
  adjustReserveAll: async (delta) => {
    const castId = get().activeCastId
    const step = delta * (useGenerationStore.getState().batchCount || 1)
    set({
      scenes: get().scenes.map((s) => {
        const reserves = { ...s.reserves }
        const next = Math.max(0, (reserves[castId] ?? 0) + step)
        if (next > 0) reserves[castId] = next
        else delete reserves[castId]
        return { ...s, reserves, reserveCount: Object.values(reserves).reduce((a, b) => a + b, 0) }
      })
    })
    await window.nais.invoke('scenes:adjustReserveAll', {
      presetId: get().activePresetId,
      castId,
      delta: step
    })
    void get().refreshReservedTotal()
  },
  clearReserveAll: async () => {
    set({ scenes: get().scenes.map((s) => ({ ...s, reserveCount: 0, reserves: {} })) })
    await window.nais.invoke('scenes:setReserveAll', { presetId: get().activePresetId, count: 0 })
    void get().refreshReservedTotal()
  },

  bulkMove: async (presetId) => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkMove', { ids, presetId })
    set({ selection: new Set() })
    // 같은 프리셋으로 옮기면 목록은 그대로 — 다른 프리셋이면 옮겨간 씬만 빠진다
    if (presetId === get().activePresetId) return
    const gone = new Set(ids)
    set({ scenes: get().scenes.filter((s) => !gone.has(s.id)) })
    if (get().selectedId != null && gone.has(get().selectedId!)) set({ selectedId: null })
  },
  bulkDelete: async () => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkDelete', { ids })
    const gone = new Set(ids)
    set({ selection: new Set(), scenes: get().scenes.filter((s) => !gone.has(s.id)) })
    if (get().selectedId != null && gone.has(get().selectedId!)) set({ selectedId: null })
  },
  bulkSetResolution: async (width, height) => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkSetResolution', { ids, width, height })
    await get().refreshScenes(ids)
  },
  bulkClearFavorites: async () => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkClearFavorites', { ids })
    await get().refreshScenes(ids)
  },
  bulkClearImages: async () => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkClearImages', { ids })
    set({ selection: new Set() })
    await get().refreshScenes(ids)
  },
  bulkExportZip: async () => {
    await window.nais.invoke('scenes:bulkExportZip', { ids: [...get().selection] })
  },

  setSceneThumb: (sceneId, filePath) =>
    set({
      // thumbnailPath로 → 카드가 새 원본을 즉시 표시.
      // 즐겨찾기가 있는 씬은 즐겨찾기가 썸네일 고정이라 교체하지 않는다 (개수만 갱신)
      scenes: get().scenes.map((s) =>
        s.id === sceneId
          ? s.hasFavorite
            ? { ...s, imageCount: s.imageCount + 1 }
            : { ...s, thumbnailPath: filePath, imageCount: s.imageCount + 1 }
          : s
      )
    }),

  loadImages: async (sceneId, reset) => {
    if (!reset && get().imagesLoading) return // 페이지네이션 중복 방지 (reset은 항상 허용)
    const seq = ++imagesSeq
    set({ imagesLoading: true })
    const offset = reset ? 0 : get().images.length
    const { items, total } = await window.nais.invoke('scenes:images', {
      sceneId,
      limit: PAGE,
      offset,
      favoritesOnly: get().favoritesOnly
    })
    if (seq !== imagesSeq || get().selectedId !== sceneId) return // 더 최신 로드가 있으면 폐기
    set((s) => ({
      images: reset ? items : [...s.images, ...items],
      imagesTotal: total,
      imagesLoading: false
    }))
  },
  toggleFavorite: async (imageId) => {
    const img = get().images.find((i) => i.id === imageId)
    if (!img) return
    const favorite = !img.favorite
    set({ images: get().images.map((i) => (i.id === imageId ? { ...i, favorite } : i)) })
    await window.nais.invoke('images:setFavorite', { id: imageId, favorite })
    // 카드 썸네일이 즐겨찾기 우선이라 해당 씬만 경량 갱신 (프리셋 전체 reload는 무거움 — N7)
    const sceneId = get().selectedId
    if (sceneId != null) void get().refreshScenes([sceneId])
  },
  deleteImage: async (imageId) => {
    const target = get().images.find((i) => i.id === imageId)
    set({
      images: get().images.filter((i) => i.id !== imageId),
      imagesTotal: Math.max(0, get().imagesTotal - 1)
    })
    // 메인 프리뷰가 이 파일을 보고 있으면 정리 — 삭제 후 깨진(NULL) 이미지 방지 (B8)
    const gen = useGenerationStore.getState()
    if (target && gen.viewingFilePath === target.filePath) gen.view(null)
    // 씬 상세의 명시적 삭제 — 파일까지 삭제 (히스토리 삭제와 달리)
    await window.nais.invoke('images:delete', { id: imageId, deleteFile: true })
    void gen.refreshHistory()
  },
  setFavoritesOnly: (v) => {
    if (v === get().favoritesOnly) return
    set({ favoritesOnly: v, images: [], imagesTotal: 0 })
    const id = get().selectedId
    if (id != null) void get().loadImages(id, true)
  },
  deleteNonFavorites: async (sceneId) => {
    const { deleted } = await window.nais.invoke('scenes:deleteNonFavorites', { sceneId })
    if (deleted > 0) {
      await get().loadImages(sceneId, true)
      // 바뀐 건 이 씬 하나 — 프리셋 전체 load()는 불필요 (N7)
      void get().refreshScenes([sceneId])
      void useGenerationStore.getState().refreshHistory()
    }
    return deleted
  },

  syncScene: async (sceneId) => {
    const { added } = await window.nais.invoke('scenes:sync', { sceneId })
    toast(added > 0 ? `외부 이미지 ${added}장 반영함` : '새로 반영할 파일 없음', 'info')
    if (added > 0) {
      await get().loadImages(sceneId, true)
      void get().refreshScenes([sceneId])
    }
  },
  syncActivePreset: async () => {
    const presetId = get().activePresetId
    const { added } = await window.nais.invoke('scenes:syncPreset', { presetId })
    toast(added > 0 ? `외부 이미지 ${added}장 반영함` : '새로 반영할 파일 없음', 'info')
    if (added > 0) {
      void get().load()
      const id = get().selectedId
      if (id != null) void get().loadImages(id, true)
    }
  },

  generateReserved: async () => {
    // 예약 = 생성 (1:1). 실행 순서는 출연별 묶음 — 사이드바 예약 전부 → 출연1 예약 전부 → …
    // (프리셋 순서는 그 안에서 유지). 예약을 큐에 넣는 즉시 소진(0).
    const castOrder = ['', ...get().casts.map((c) => c.id)]
    const castById = new Map(get().casts.map((c) => [c.id, c]))

    // 예약된 씬만 전 프리셋 통틀어 한 번에 조회 — 프리셋마다 무거운 scenes:list(썸네일 포함)를
    // 순차 호출하던 걸 대체. 예약 스캔에 썸네일은 필요 없다 (N8, 대량 생성 시작 시 렉의 원인)
    const { items: reservedScenes } = await window.nais.invoke('scenes:reserved', undefined)
    if (reservedScenes.length === 0) return

    // DB는 preset_id 순으로 오므로, 사용자가 정렬한 프리셋 순서(폴더/드래그 반영)로 재정렬
    const presetOrder = new Map(get().presets.map((p, i) => [p.id, i]))
    reservedScenes.sort(
      (a, b) => (presetOrder.get(a.presetId) ?? 0) - (presetOrder.get(b.presetId) ?? 0)
    )

    // 현재 열린 프리셋 카드 배지 즉시 소진(낙관적) + DB는 전 프리셋 한 번에 초기화
    set({
      scenes: get().scenes.map((s) =>
        s.reserveCount > 0 ? { ...s, reserveCount: 0, reserves: {} } : s
      )
    })
    void window.nais.invoke('scenes:clearAllReserves', undefined)

    // 등록을 건당 개별 invoke로 하면 큐가 매번 전체 상태를 broadcast해서 대량 예약 시
    // 등록 단계 자체가 O(n²)로 렉이 생긴다 (N7) — 전부 모아서 한 번에 등록
    const batch: { request: GenerationRequest; count: number }[] = []
    for (const castId of castOrder) {
      const cast = castId === '' ? null : (castById.get(castId) ?? null)
      if (castId !== '' && !cast) continue // 삭제된 출연의 예약은 건너뜀
      for (const scene of reservedScenes) {
        const count = scene.reserves[castId] ?? 0
        for (let i = 0; i < count; i++) {
          batch.push({ request: { ...buildSceneRequest(scene, cast), seed: sceneSeed(i) }, count: 1 })
        }
      }
    }
    if (batch.length > 0) await window.nais.invoke('queue:enqueueMany', { entries: batch })
    set({ reservedTotal: 0 })
  },

  generateOne: async (sceneId) => {
    const scene = get().scenes.find((s) => s.id === sceneId)
    if (!scene) return
    // 단건 생성도 현재 선택된 출연으로 (셀렉터가 곧 "지금 누구로 뽑는지")
    const castId = get().activeCastId
    const cast = castId === '' ? null : (get().casts.find((c) => c.id === castId) ?? null)
    await window.nais.invoke('queue:enqueue', {
      request: { ...buildSceneRequest(scene, cast), seed: sceneSeed(0) },
      count: 1
    })
  },

  // ── 출연(Cast) ──────────────────────────────────────────
  casts: [],
  activeCastId: localStorage.getItem('scene_active_cast') ?? '',
  setActiveCast: (activeCastId) => {
    set({ activeCastId })
    localStorage.setItem('scene_active_cast', activeCastId)
  },
  addCast: (data) => {
    const cast: SceneCast = {
      id: `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
      color: nextCastColor(get().casts),
      ...data
    }
    set({ casts: [...get().casts, cast] })
    persistCasts()
  },
  updateCast: (id, patch) => {
    set({ casts: get().casts.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
    persistCasts()
  },
  removeCast: (id) => {
    set({ casts: get().casts.filter((c) => c.id !== id) })
    if (get().activeCastId === id) get().setActiveCast('')
    persistCasts()
  },
  reorderCasts: (ids) => {
    const byId = new Map(get().casts.map((c) => [c.id, c]))
    const next = ids.map((id) => byId.get(id)).filter((c): c is SceneCast => !!c)
    if (next.length !== get().casts.length) return // 목록이 어긋나면 무시 (동시 삭제 등)
    set({ casts: next })
    persistCasts()
  }
}))

/** 씬 생성 시드 — 시드 고정을 존중 (고정이면 base+offset, 아니면 랜덤) */
function sceneSeed(offset: number): number {
  const g = useGenerationStore.getState()
  return g.seedLocked && g.request.seed >= 0 ? (g.request.seed + offset) % 4294967296 : randomSeed()
}

/**
 * 출연 배지 색 팔레트 — 사이드바 예약 배지(danger 빨강)와 겹치지 않는 색만.
 * 흰 글자 대비가 나오는 500~600 톤.
 */
export const CAST_COLORS = [
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#8b5cf6', // violet
  '#d97706', // amber
  '#d946ef', // fuchsia
  '#6366f1', // indigo
  '#0d9488', // teal
  '#65a30d' // lime
]

/** 다음 출연 색 — 아직 안 쓴 색 우선, 다 쓰면 순환 */
export function nextCastColor(casts: SceneCast[]): string {
  const used = new Set(casts.map((c) => c.color))
  return CAST_COLORS.find((c) => !used.has(c)) ?? CAST_COLORS[casts.length % CAST_COLORS.length]
}

/** 출연 목록 persist (settings JSON — 디바운스) */
let castsSaveTimer: ReturnType<typeof setTimeout> | undefined
function persistCasts(): void {
  clearTimeout(castsSaveTimer)
  castsSaveTimer = setTimeout(() => {
    void window.nais.invoke('settings:set', {
      key: 'scene_casts',
      value: JSON.stringify(useScenesStore.getState().casts)
    })
  }, 300)
}

/** 출연 목록 복원 — SceneMode 마운트 시 1회 */
let castsLoaded = false
export async function loadCasts(): Promise<void> {
  if (castsLoaded) return
  castsLoaded = true
  const { value } = await window.nais.invoke('settings:get', { key: 'scene_casts' })
  if (!value) return
  try {
    const casts = JSON.parse(value) as SceneCast[]
    if (Array.isArray(casts)) {
      // color 없는 구버전 저장분 백필
      const filled: SceneCast[] = []
      for (const c of casts) filled.push(c.color ? c : { ...c, color: nextCastColor(filled) })
      useScenesStore.setState({ casts: filled })
    }
  } catch {
    // 깨진 저장값은 무시
  }
  // 삭제된 출연이 활성으로 남아있으면 사이드바로
  const st = useScenesStore.getState()
  if (st.activeCastId && !st.casts.some((c) => c.id === st.activeCastId)) st.setActiveCast('')
}

/**
 * 씬 생성 완료 이벤트 바인딩 (목록 썸네일/개수 + 열린 상세 이미지 갱신).
 * 대량 배치 시 이벤트가 쏟아지므로 디바운스로 DB 부하·리렌더를 줄인다.
 */
export function bindSceneEvents(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let reloadSelected = false
  const changedIds = new Set<number>()
  return window.nais.on('scenes:changed', ({ sceneId, filePath }) => {
    const st = useScenesStore.getState()
    // 완료 즉시 카드 낙관적 갱신 — 스트리밍 프레임이 사라진 뒤 옛 썸네일이 튀는 것 방지.
    // 새 원본을 thumbnailPath로 바로 표시, refreshScenes가 곧 정식 썸네일(nais-image 프로토콜)로 대체.
    st.setSceneThumb(sceneId, filePath)
    changedIds.add(sceneId)
    if (st.selectedId === sceneId) reloadSelected = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      const s = useScenesStore.getState()
      // 바뀐 씬만 경량 재조회 — 프리셋 전체 load()는 씬 많을 때 썸네일 전부 재조회라 무거움 (N7)
      void s.refreshScenes([...changedIds])
      changedIds.clear()
      if (reloadSelected && s.selectedId != null) void s.loadImages(s.selectedId, true)
      reloadSelected = false
    }, 300)
  })
}
