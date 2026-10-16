import type { ReactNode } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { enedisApi, syncApi, pdlApi } = vi.hoisted(() => {
  const ok = () => Promise.resolve({ success: true, data: { grandeur: [{ points: [] }] } })
  return {
    enedisApi: { getConsumptionDaily: vi.fn(ok), getMaxPower: vi.fn(ok) },
    syncApi: { getStatusPdl: vi.fn() },
    pdlApi: { list: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
  }
})

vi.mock('@/api/enedis', () => ({ enedisApi }))
vi.mock('@/api/sync', () => ({ syncApi }))
vi.mock('@/api/pdl', () => ({ pdlApi }))

import { useConsumptionData } from '../useConsumptionData'

const PRM = '99999999999991'
const WINDOW = { start: '2023-10-17', end: '2026-10-15' }

function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(() => useConsumptionData(PRM, WINDOW, null), { wrapper })
}

const starts = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map((call) => (call[1] as { start: string }).start).sort()

afterEach(() => vi.clearAllMocks())

// MED-64 : la requête de la page (rafraîchie toutes les heures) ne doit pas ramener l'historique à 3 ans
describe('useConsumptionData : historique local de plus de 3 ans', () => {
  it('journalier et puissance max partent de la donnée locale la plus ancienne', async () => {
    syncApi.getStatusPdl.mockResolvedValue({
      sync_types: { consumption_daily: { oldest_data_date: '2019-03-01' }, max_power_daily: { oldest_data_date: '2019-03-02' } },
    })

    render()

    await waitFor(() => expect(enedisApi.getConsumptionDaily).toHaveBeenCalled())
    await waitFor(() => expect(enedisApi.getMaxPower).toHaveBeenCalled())
    expect(starts(enedisApi.getConsumptionDaily)[0]).toBe('2019-03-01')
    expect(starts(enedisApi.getMaxPower)[0]).toBe('2019-03-02')
  })

  it('les morceaux annuels se touchent (fin exclue par l API) : aucun jour perdu à leurs frontières', async () => {
    syncApi.getStatusPdl.mockResolvedValue({ sync_types: { consumption_daily: { oldest_data_date: '2019-03-01' } } })

    render()

    await waitFor(() => expect(enedisApi.getConsumptionDaily.mock.calls.length).toBeGreaterThan(1))
    const ranges = (enedisApi.getConsumptionDaily.mock.calls as unknown[][])
      .map((call) => call[1] as { start: string; end: string })
      .sort((a, b) => a.start.localeCompare(b.start))
    ranges.slice(1).forEach((r, i) => expect(r.start).toBe(ranges[i].end))
    expect(ranges[ranges.length - 1].end).toBe(WINDOW.end)
  })

  it('statut de synchro indisponible : la fenêtre de la page', async () => {
    syncApi.getStatusPdl.mockRejectedValue(new Error('500'))

    render()

    await waitFor(() => expect(enedisApi.getConsumptionDaily).toHaveBeenCalled())
    expect(starts(enedisApi.getConsumptionDaily)[0]).toBe(WINDOW.start)
  })
})
