import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { syncApi } from '@/api/sync'
import {
  AUTO_REFRESH_INTERVAL_MS,
  SYNC_SIGNATURE_KEY_PREFIX,
  computeSyncSignature,
  shouldRefresh,
  useClientAutoRefresh,
  type PdlSyncStatus,
} from '../useClientAutoRefresh'

vi.mock('@/api/sync', () => ({ syncApi: { getStatusPdl: vi.fn() } }))

const PDL = '12345678901234'

const status = (dailyNewest: string | null, detailNewest: string | null, lastSync = '2026-10-16T06:00:00'): PdlSyncStatus => ({
  usage_point_id: PDL,
  sync_types: {
    consumption_daily: { newest_data_date: dailyNewest, last_sync_at: lastSync },
    consumption_detailed: { newest_data_date: detailNewest, last_sync_at: lastSync },
  },
})

// L'API renvoie le statut brut (route sans enveloppe APIResponse)
const mockStatus = (s: PdlSyncStatus) =>
  vi.mocked(syncApi.getStatusPdl).mockResolvedValue(s as unknown as Awaited<ReturnType<typeof syncApi.getStatusPdl>>)

// Laisse passer les promesses (lecture du statut puis refresh) sans avancer le temps
const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('computeSyncSignature', () => {
  it('ne dépend que des newest_data_date, pas de last_sync_at', () => {
    const a = computeSyncSignature(status('2026-10-15', '2026-10-15', '2026-10-16T06:00:00'))
    const b = computeSyncSignature(status('2026-10-15', '2026-10-15', '2026-10-16T06:30:00'))
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('change quand une donnée plus récente arrive', () => {
    const before = computeSyncSignature(status('2026-10-14', '2026-10-14'))
    const after = computeSyncSignature(status('2026-10-15', '2026-10-14'))
    expect(before).not.toBe(after)
  })

  it('change quand un import V1 recule la donnée la plus ancienne (MED-64)', () => {
    const before = status('2026-10-15', '2026-10-15')
    const after = status('2026-10-15', '2026-10-15')
    after.sync_types.consumption_daily = { ...after.sync_types.consumption_daily, oldest_data_date: '2021-01-01' }
    expect(computeSyncSignature(before)).not.toBe(computeSyncSignature(after))
  })

  it("ne dépend pas de l'ordre des types de synchro", () => {
    const s1 = status('2026-10-15', '2026-10-14')
    const s2: PdlSyncStatus = {
      usage_point_id: PDL,
      sync_types: {
        consumption_detailed: s1.sync_types.consumption_detailed,
        consumption_daily: s1.sync_types.consumption_daily,
      },
    }
    expect(computeSyncSignature(s1)).toBe(computeSyncSignature(s2))
  })

  it('renvoie null sans statut', () => {
    expect(computeSyncSignature(null)).toBeNull()
  })
})

describe('shouldRefresh', () => {
  it('relance quand le cache du navigateur est vide', () => {
    expect(shouldRefresh({ hasCache: false, previousSignature: 'x', currentSignature: 'x' })).toBe(true)
  })

  it('relance quand la signature a changé', () => {
    expect(shouldRefresh({ hasCache: true, previousSignature: 'a', currentSignature: 'b' })).toBe(true)
  })

  it('ne relance pas quand la signature est identique et le cache présent', () => {
    expect(shouldRefresh({ hasCache: true, previousSignature: 'a', currentSignature: 'a' })).toBe(false)
  })

  it('relance quand aucune signature n\'a été mémorisée (cache rempli avant cette version)', () => {
    expect(shouldRefresh({ hasCache: true, previousSignature: null, currentSignature: 'a' })).toBe(true)
  })

  it('ne relance pas un cache présent quand le statut est illisible', () => {
    expect(shouldRefresh({ hasCache: true, previousSignature: 'a', currentSignature: null })).toBe(false)
  })
})

describe('useClientAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.mocked(syncApi.getStatusPdl).mockReset()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('récupère seul au chargement quand le cache est vide (nouvel appareil)', async () => {
    mockStatus(status('2026-10-15', '2026-10-15'))
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => false, refresh }))
    await flush()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('mémorise la signature après une récupération réussie', async () => {
    const s = status('2026-10-15', '2026-10-15')
    mockStatus(s)
    let cached = false
    const refresh = vi.fn().mockImplementation(async () => { cached = true })

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => cached, refresh }))
    await flush()

    expect(localStorage.getItem(SYNC_SIGNATURE_KEY_PREFIX + PDL)).toBe(computeSyncSignature(s))
  })

  it('ne mémorise rien quand la récupération laisse le cache vide (erreurs avalées par fetchAllData)', async () => {
    mockStatus(status('2026-10-15', '2026-10-15'))
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => false, refresh }))
    await flush()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SYNC_SIGNATURE_KEY_PREFIX + PDL)).toBeNull()
  })

  it('ne récupère pas quand le cache est à jour de la dernière synchro', async () => {
    const s = status('2026-10-15', '2026-10-15')
    localStorage.setItem(SYNC_SIGNATURE_KEY_PREFIX + PDL, computeSyncSignature(s) ?? '')
    mockStatus(s)
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => true, refresh }))
    await flush()

    expect(syncApi.getStatusPdl).toHaveBeenCalledWith(PDL)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('relit le statut toutes les 30 min et récupère quand une donnée nouvelle est arrivée', async () => {
    const before = status('2026-10-14', '2026-10-14')
    localStorage.setItem(SYNC_SIGNATURE_KEY_PREFIX + PDL, computeSyncSignature(before) ?? '')
    mockStatus(before)
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => true, refresh }))
    await flush()
    expect(refresh).not.toHaveBeenCalled()

    mockStatus(status('2026-10-15', '2026-10-15'))
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_INTERVAL_MS)
    })
    await flush()

    expect(syncApi.getStatusPdl).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("relit le statut quand l'onglet redevient visible (timers suspendus sur mobile)", async () => {
    const s = status('2026-10-14', '2026-10-14')
    localStorage.setItem(SYNC_SIGNATURE_KEY_PREFIX + PDL, computeSyncSignature(s) ?? '')
    mockStatus(s)
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => true, refresh }))
    await flush()

    mockStatus(status('2026-10-15', '2026-10-15'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('ne lance pas deux récupérations en même temps', async () => {
    mockStatus(status('2026-10-15', '2026-10-15'))
    let release: () => void = () => {}
    const refresh = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => false, refresh }))
    await flush()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()

    expect(refresh).toHaveBeenCalledTimes(1)
    release()
  })

  it('récupère quand même un cache vide si le statut est illisible (404 avant la première synchro)', async () => {
    vi.mocked(syncApi.getStatusPdl).mockRejectedValue(new Error('404'))
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => false, refresh }))
    await flush()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('ne fait rien quand il est désactivé (mode serveur, démo)', async () => {
    mockStatus(status('2026-10-15', '2026-10-15'))
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useClientAutoRefresh({ usagePointId: PDL, enabled: false, hasCachedData: () => false, refresh }))
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_INTERVAL_MS * 2)
    })
    await flush()

    expect(syncApi.getStatusPdl).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("arrête l'intervalle au démontage", async () => {
    mockStatus(status('2026-10-15', '2026-10-15'))
    const refresh = vi.fn().mockResolvedValue(undefined)

    const { unmount } = renderHook(() =>
      useClientAutoRefresh({ usagePointId: PDL, enabled: true, hasCachedData: () => true, refresh })
    )
    await flush()
    const calls = vi.mocked(syncApi.getStatusPdl).mock.calls.length
    unmount()
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_INTERVAL_MS * 2)
    })

    expect(vi.mocked(syncApi.getStatusPdl).mock.calls.length).toBe(calls)
  })
})
