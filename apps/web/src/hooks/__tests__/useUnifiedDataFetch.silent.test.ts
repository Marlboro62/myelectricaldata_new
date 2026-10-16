import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { enedisApi } from '@/api/enedis'
import { toast } from '@/stores/notificationStore'
import { useUnifiedDataFetch } from '../useUnifiedDataFetch'
import type { PDL } from '@/types/api'

vi.mock('@/api/enedis', () => ({
  enedisApi: {
    getConsumptionDaily: vi.fn(),
    getMaxPower: vi.fn(),
    getConsumptionDetailBatch: vi.fn(),
    getProductionDaily: vi.fn(),
    getProductionDetailBatch: vi.fn(),
  },
}))
vi.mock('@/stores/notificationStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}))
const broadcast = vi.fn()
vi.mock('../useCacheBroadcast', () => ({ useCacheBroadcast: () => ({ broadcast, subscribe: vi.fn() }) }))

const PDL_ID = '12345678901234'
const pdl = { id: 'p1', usage_point_id: PDL_ID, has_consumption: true, has_production: false, is_active: true } as unknown as PDL

const measure = {
  success: true,
  data: {
    meter_reading: {
      usage_point_id: PDL_ID,
      start: '2026-10-14',
      end: '2026-10-15',
      reading_type: { unit: 'Wh' },
      interval_reading: [{ value: '1000', date: '2026-10-14' }],
    },
  },
}

const renderFetch = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(
    () => useUnifiedDataFetch({ selectedPDL: PDL_ID, selectedPDLDetails: pdl, allPDLs: [pdl], pageContext: 'all' }),
    { wrapper }
  )
}

describe('useUnifiedDataFetch, option silent (MED-68)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(enedisApi.getConsumptionDaily).mockResolvedValue(measure as never)
    vi.mocked(enedisApi.getMaxPower).mockResolvedValue(measure as never)
    vi.mocked(enedisApi.getConsumptionDetailBatch).mockResolvedValue(measure as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('affiche les toasts de succès sans option (clic sur Récupérer)', async () => {
    const { result } = renderFetch()
    await act(async () => {
      await result.current.fetchAllData()
      vi.advanceTimersByTime(2000)
    })

    expect(toast.success).toHaveBeenCalled()
  })

  it("n'affiche aucun toast en mode silencieux, mais prévient les autres onglets", async () => {
    const { result } = renderFetch()
    await act(async () => {
      await result.current.fetchAllData({ silent: true })
      vi.advanceTimersByTime(2000)
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.loading).not.toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'CACHE_UPDATED' }))
  })

  it("n'affiche pas d'erreur en mode silencieux (relecture de fond toutes les 30 min)", async () => {
    vi.mocked(enedisApi.getConsumptionDaily).mockRejectedValue(new Error('réseau'))
    const { result } = renderFetch()
    await act(async () => {
      await result.current.fetchAllData({ silent: true })
      vi.advanceTimersByTime(2000)
    })

    expect(toast.error).not.toHaveBeenCalled()
  })
})
