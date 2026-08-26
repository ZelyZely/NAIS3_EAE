import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { getDb } from './index'

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

const TOKEN_KEY = 'nai_token_encrypted'
const ACCOUNTS_KEY = 'nai_accounts_encrypted'

export interface StoredNaiAccount {
  id: string
  label: string
  token: string
}

interface StoredNaiAccountState {
  version: 1
  activeId: string | null
  accounts: StoredNaiAccount[]
}

function encrypt(value: string): string {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value).toString('base64')
    : Buffer.from(value).toString('base64')
}

function decrypt(value: string): string | null {
  const buf = Buffer.from(value, 'base64')
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf-8')
  } catch {
    return null
  }
}

function legacyToken(): string | null {
  const stored = getSetting(TOKEN_KEY)
  return stored ? decrypt(stored) : null
}

function normalizeState(value: unknown): StoredNaiAccountState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<StoredNaiAccountState>
  if (!Array.isArray(raw.accounts)) return null
  const accounts = raw.accounts.filter(
    (account): account is StoredNaiAccount =>
      !!account &&
      typeof account.id === 'string' &&
      typeof account.label === 'string' &&
      typeof account.token === 'string' &&
      account.token.trim().length > 0
  )
  const activeId = accounts.some((account) => account.id === raw.activeId)
    ? (raw.activeId ?? null)
    : (accounts[0]?.id ?? null)
  return { version: 1, activeId, accounts }
}

function saveNaiAccountState(state: StoredNaiAccountState): void {
  setSetting(ACCOUNTS_KEY, encrypt(JSON.stringify(state)))

  // 구버전으로 되돌렸을 때도 현재 활성 계정을 읽을 수 있도록 기존 키를 동기화한다.
  const active = state.accounts.find((account) => account.id === state.activeId)
  if (active) setSetting(TOKEN_KEY, encrypt(active.token))
  else getDb().prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY)
}

function loadNaiAccountState(): StoredNaiAccountState {
  const stored = getSetting(ACCOUNTS_KEY)
  if (stored) {
    const plaintext = decrypt(stored)
    if (plaintext) {
      try {
        const parsed = normalizeState(JSON.parse(plaintext))
        if (parsed) return parsed
      } catch {
        // 손상된 다계정 값은 아래의 구버전 단일 토큰 복구 경로로 넘긴다.
      }
    }
  }

  const token = legacyToken()
  const migrated: StoredNaiAccountState = token
    ? {
        version: 1,
        activeId: randomUUID(),
        accounts: []
      }
    : { version: 1, activeId: null, accounts: [] }
  if (token && migrated.activeId) {
    migrated.accounts.push({ id: migrated.activeId, label: '계정 1', token })
    saveNaiAccountState(migrated)
  }
  return migrated
}

function cleanLabel(label: string | undefined, fallback: string): string {
  const cleaned = label?.trim().slice(0, 60)
  return cleaned || fallback
}

/**
 * NAI 토큰은 OS 키체인 기반 safeStorage로 암호화해 저장한다.
 * (NAIS2에서 "설정 파일 못 뜯어본다"는 불만이 있었지만 토큰만큼은 평문 금지)
 */
export function setNaiToken(token: string): void {
  const state = loadNaiAccountState()
  const normalized = token.trim()
  const active = state.accounts.find((account) => account.id === state.activeId)
  if (active) active.token = normalized
  else {
    const id = randomUUID()
    state.accounts.push({ id, label: '계정 1', token: normalized })
    state.activeId = id
  }
  saveNaiAccountState(state)
}

export function getNaiToken(): string | null {
  return getActiveNaiAccount()?.token ?? null
}

export function deleteNaiToken(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(ACCOUNTS_KEY)
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY)
}

/** 마스킹 표시용 메타 (WHIMS 프로바이더 키 UI 패턴) */
export function getNaiTokenInfo(): { hasToken: boolean; prefix: string; length: number } {
  const token = getNaiToken()
  if (!token) return { hasToken: false, prefix: '', length: 0 }
  return { hasToken: true, prefix: token.slice(0, 4), length: token.length }
}

export function getNaiAccounts(): StoredNaiAccount[] {
  return loadNaiAccountState().accounts.map((account) => ({ ...account }))
}

export function getActiveNaiAccount(): StoredNaiAccount | null {
  const state = loadNaiAccountState()
  return state.accounts.find((account) => account.id === state.activeId) ?? null
}

export function addNaiAccount(token: string, label?: string): StoredNaiAccount {
  const state = loadNaiAccountState()
  const normalized = token.trim()
  const duplicate = state.accounts.find((account) => account.token === normalized)
  if (duplicate) {
    duplicate.label = cleanLabel(label, duplicate.label)
    state.activeId = duplicate.id
    saveNaiAccountState(state)
    return { ...duplicate }
  }

  const account: StoredNaiAccount = {
    id: randomUUID(),
    label: cleanLabel(label, `계정 ${state.accounts.length + 1}`),
    token: normalized
  }
  state.accounts.push(account)
  state.activeId = account.id
  saveNaiAccountState(state)
  return { ...account }
}

export function setActiveNaiAccount(id: string): boolean {
  const state = loadNaiAccountState()
  if (!state.accounts.some((account) => account.id === id)) return false
  state.activeId = id
  saveNaiAccountState(state)
  return true
}

export function getNaiAccountToken(id: string): string | null {
  return loadNaiAccountState().accounts.find((account) => account.id === id)?.token ?? null
}

export function deleteNaiAccount(id: string): string | null {
  const state = loadNaiAccountState()
  const index = state.accounts.findIndex((account) => account.id === id)
  if (index < 0) return state.activeId
  state.accounts.splice(index, 1)
  if (state.activeId === id) {
    state.activeId = state.accounts[index]?.id ?? state.accounts[index - 1]?.id ?? null
  }
  saveNaiAccountState(state)
  return state.activeId
}
