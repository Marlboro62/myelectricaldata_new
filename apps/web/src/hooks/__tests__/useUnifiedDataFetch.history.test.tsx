import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PDL } from '@/types/api'

const { enedisApi, syncApi } = vi.hoisted(() => {
  const ok = () => Promise.resolve({ success: true, data: null })
  return {
    enedisApi: {
      getConsumptionDaily: vi.fn(ok),
      getMaxPower: vi.fn(ok),
      getConsumptionDetailBatch: vi.fn(ok),
      getProductionDaily: vi.fn(ok),
      getProductionDetailBatch: vi.fn(ok),
    },
    syncApi: { getStatusPdl: vi.fn() },
  }
})

vi.mock('@/api/enedis', () => ({ enedisApi }))
vi.mock('@/api/sync', () => ({ syncApi }))
vi.mock('@/stores/notificationStore', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))
vi.mock('../useCacheBroadcast', () => ({ useCacheBroadcast: () => ({ broadcast: vi.fn() }) }))

import { useUnifiedDataFetch } from '../useUnifiedDataFetch'

const PRM = '99999999999991'
const pdl = { id: 'pdl-1', usage_point_id: PRM, has_consumption: true, has_production: true } as unknown as PDL

// « Aujourd'hui » = 2026-10-16 : fin J-1 = 2026-10-15, fenêtres Enedis inchangées
const END = '2026-10-15'
const DAILY_WINDOW = '2023-10-16' // J-1 - 1095 jours
const DETAIL_WINDOW = '2024-10-16' // aujourd'hui - 2 ans

function status(oldest: Record<string, string | null>) {
  return {
    usage_point_id: PRM,
    sync_types: Object.fromEntries(Object.entries(oldest).map(([key, date]) => [key, { oldest_data_date: date }])),
  }
}

async function fetchAll() {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(
    () => useUnifiedDataFetch({ selectedPDL: PRM, selectedPDLDetails: pdl, allPDLs: [pdl], pageContext: 'all' }),
    { wrapper },
  )
  await result.current.fetchAllData()
}

const startOf = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0][1] as { start: string; end: string })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 16, 10, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  delete (window as any).__ENV__
})

// MED-64 : le client local demande tout son historique, plus seulement 3 ans
describe('useUnifiedDataFetch : historique local de plus de 3 ans', () => {
  it('mode client : chaque série part de sa donnée locale la plus ancienne', async () => {
    syncApi.getStatusPdl.mockResolvedValue(status({
      consumption_daily: '2019-03-01',
      consumption_detailed: '2019-03-01',
      max_power_daily: '2019-03-02',
      production_daily: '2020-05-01',
      production_detailed: '2020-05-01',
    }))

    await fetchAll()

    expect(syncApi.getStatusPdl).toHaveBeenCalledWith(PRM)
    expect(startOf(enedisApi.getConsumptionDaily)).toMatchObject({ start: '2019-03-01', end: END })
    expect(startOf(enedisApi.getMaxPower)).toMatchObject({ start: '2019-03-02', end: END })
    expect(startOf(enedisApi.getConsumptionDetailBatch)).toMatchObject({ start: '2019-03-01', end: END })
    expect(startOf(enedisApi.getProductionDaily)).toMatchObject({ start: '2020-05-01', end: END })
    expect(startOf(enedisApi.getProductionDetailBatch)).toMatchObject({ start: '2020-05-01', end: END })
  })

  it('mode client, données locales récentes : les fenêtres Enedis, pour combler les trous', async () => {
    syncApi.getStatusPdl.mockResolvedValue(status({ consumption_daily: '2025-01-01', consumption_detailed: '2025-06-01' }))

    await fetchAll()

    expect(startOf(enedisApi.getConsumptionDaily).start).toBe(DAILY_WINDOW)
    expect(startOf(enedisApi.getConsumptionDetailBatch).start).toBe(DETAIL_WINDOW)
  })

  it('mode client, statut de synchro indisponible : les fenêtres Enedis, sans bloquer le chargement', async () => {
    syncApi.getStatusPdl.mockRejectedValue(new Error('500'))

    await fetchAll()

    expect(startOf(enedisApi.getConsumptionDaily).start).toBe(DAILY_WINDOW)
    expect(startOf(enedisApi.getMaxPower).start).toBe(DAILY_WINDOW)
    expect(startOf(enedisApi.getConsumptionDetailBatch).start).toBe(DETAIL_WINDOW)
    expect(startOf(enedisApi.getProductionDaily).start).toBe(DAILY_WINDOW)
  })

  it('mode serveur : pas de statut de synchro, les fenêtres Enedis comme avant', async () => {
    ;(window as any).__ENV__ = { VITE_SERVER_MODE: 'true' }

    await fetchAll()

    expect(syncApi.getStatusPdl).not.toHaveBeenCalled()
    expect(startOf(enedisApi.getConsumptionDaily).start).toBe(DAILY_WINDOW)
    expect(startOf(enedisApi.getConsumptionDetailBatch).start).toBe(DETAIL_WINDOW)
  })
})
