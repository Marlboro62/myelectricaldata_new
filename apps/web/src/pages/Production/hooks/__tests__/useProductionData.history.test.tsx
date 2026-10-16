import type { ReactNode } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { enedisApi, syncApi, pdlApi } = vi.hoisted(() => ({
  enedisApi: { getProductionDaily: vi.fn((_pdl: string, _range: { start: string; end: string }) => Promise.resolve({ success: true, data: { grandeur: [{ points: [] }] } })) },
  syncApi: { getStatusPdl: vi.fn() },
  pdlApi: { list: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
}))

vi.mock('@/api/enedis', () => ({ enedisApi }))
vi.mock('@/api/sync', () => ({ syncApi }))
vi.mock('@/api/pdl', () => ({ pdlApi }))

import { useProductionData } from '../useProductionData'

const PRM = '99999999999991'

afterEach(() => vi.clearAllMocks())

// MED-64 : la requête de la page Production ne doit pas ramener l'historique à 3 ans
describe('useProductionData : historique local de plus de 3 ans', () => {
  it('le journalier part de la donnée locale la plus ancienne', async () => {
    syncApi.getStatusPdl.mockResolvedValue({ sync_types: { production_daily: { oldest_data_date: '2020-05-01' } } })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useProductionData(PRM, { start: '2023-10-17', end: '2026-10-15' }, null), { wrapper })

    await waitFor(() => expect(enedisApi.getProductionDaily).toHaveBeenCalled())
    const starts = enedisApi.getProductionDaily.mock.calls.map(([, range]) => range.start).sort()
    expect(starts[0]).toBe('2020-05-01')
  })
})
