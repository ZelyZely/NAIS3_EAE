import Database from 'better-sqlite3'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { migrations } from './migrations'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized — call initDb() first')
  return db
}

export function getDbPath(): string {
  return join(app.getPath('userData'), 'nais3.db')
}

/**
 * v1.0.18에서 앱 표시 이름을 'NAIS3'→'NAIS3 EAE'로 바꾸면서 Electron 기본 userData 경로
 * (…/<appData>/<app.name>)도 함께 바뀌어, 이름 변경 전 데이터(DB·라이브러리·레퍼런스)가
 * 옛 경로("…/NAIS3")에 고아로 남는 문제가 있었다. 새 경로에 아직 실사용 데이터가 없으면
 * 옛 경로에서 1회만 이관한다 — 새 경로에 이미 뭔가 쌓여 있으면(정상적으로 이 이름으로
 * 써온 설치) 절대 건드리지 않는다.
 */
function migrateLegacyUserData(newDir: string, newDbPath: string): void {
  const legacyDir = join(app.getPath('appData'), 'NAIS3')
  const legacyDbPath = join(legacyDir, 'nais3.db')
  if (legacyDbPath === newDbPath || !existsSync(legacyDbPath)) return

  if (existsSync(newDbPath)) {
    let rows = 0
    try {
      const probe = new Database(newDbPath, { readonly: true })
      const hasTable = probe
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='scene_presets'`
        )
        .get() as { n: number }
      if (hasTable.n > 0) {
        rows = (
          probe
            .prepare(
              `SELECT (SELECT COUNT(*) FROM images) + (SELECT COUNT(*) FROM gen_scenes) AS n`
            )
            .get() as { n: number }
        ).n
      }
      probe.close()
    } catch {
      return // 새 경로 DB를 읽을 수 없으면 안전하게 건드리지 않는다
    }
    if (rows > 0) return // 새 경로에 이미 실사용 데이터가 있음 — 이관 대상 아님
    // 스키마만 있는 빈 스텁 — 옛 데이터로 교체하기 위해 지운다
    for (const f of ['nais3.db', 'nais3.db-wal', 'nais3.db-shm']) {
      try {
        rmSync(join(newDir, f))
      } catch {
        // 애초에 없던 파일이면 무시
      }
    }
  }

  mkdirSync(newDir, { recursive: true })
  for (const name of ['nais3.db', 'nais3.db-wal', 'nais3.db-shm']) {
    const src = join(legacyDir, name)
    if (existsSync(src)) renameSync(src, join(newDir, name))
  }
  for (const name of ['library', 'refs', 'backups']) {
    const src = join(legacyDir, name)
    const dest = join(newDir, name)
    if (existsSync(src) && !existsSync(dest)) renameSync(src, dest)
  }
}

/**
 * DB 열기 + 마이그레이션.
 *
 * 안전장치 (NAIS2 세이브 유실 문제의 근본 대책):
 * - WAL 모드: 크래시 시에도 커밋된 데이터 보존
 * - 마이그레이션 필요 시 실행 전 파일 백업 자동 생성 (pre-migration-v{N}.db)
 * - 각 마이그레이션은 개별 트랜잭션: 실패하면 해당 버전 이전 상태로 남고 앱은 에러 표면화
 */
export function initDb(): { version: number; path: string } {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = getDbPath()

  migrateLegacyUserData(dir, path)

  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const current = db.pragma('user_version', { simple: true }) as number
  const target = migrations.length

  if (current < target) {
    if (current > 0 && existsSync(path)) {
      backupBeforeMigration(path, current)
    }
    for (let v = current; v < target; v++) {
      const migrate = db.transaction(() => {
        migrations[v](db!)
        db!.pragma(`user_version = ${v + 1}`)
      })
      migrate()
    }
  } else if (current > target) {
    // 다운그레이드된 앱이 미래 버전 DB를 여는 상황 — 조용히 진행하면 데이터가 깨진다
    throw new Error(
      `DB version ${current} is newer than app supports (${target}). ` +
        'NAIS3를 최신 버전으로 업데이트하세요.'
    )
  }

  return { version: target, path }
}

function backupBeforeMigration(path: string, fromVersion: number): void {
  const backupDir = join(app.getPath('userData'), 'backups')
  mkdirSync(backupDir, { recursive: true })
  copyFileSync(path, join(backupDir, `pre-migration-v${fromVersion}.db`))
  pruneBackups(backupDir, 10)
}

function pruneBackups(backupDir: string, keep: number): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, f))
  }
}

/** 주기 백업용: 압축 정리된 스냅샷을 원자적으로 생성 */
export function backupNow(): string {
  const backupDir = join(app.getPath('userData'), 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(backupDir, `auto-${stamp}.db`)
  getDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  pruneBackups(backupDir, 10)
  return dest
}

export function closeDb(): void {
  db?.close()
  db = null
}
