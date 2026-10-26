import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LoadingStatusBadge } from '../LoadingStatusBadge'
import { useDataFetchStore } from '@/stores/dataFetchStore'

function hover() {
  const { container } = render(<LoadingStatusBadge />)
  fireEvent.mouseEnter(container.firstChild as Element)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 16, 10)))
})

afterEach(() => {
  vi.useRealTimers()
  useDataFetchStore.getState().resetLoadingStatus()
})

// MED-64 : le badge annonce la plage réellement chargée, plus « 3 ans » en dur
describe('LoadingStatusBadge : profondeur d historique', () => {
  it('plage locale de plus de 3 ans : dates et profondeur réelles', () => {
    useDataFetchStore.getState().updateConsumptionStatus({
      daily: 'success',
      dailyRange: { start: '2019-03-01', end: '2026-10-15' },
      detail: 'success',
      detailRange: { start: '2019-03-01', end: '2026-10-15' },
    })

    hover()

    expect(screen.getAllByText('01/03/2019 → 15/10/2026 (8 ans)')).toHaveLength(2)
  })

  it('sans plage publiée : la fenêtre Enedis, 3 ans en quotidien et 2 ans en détaillé', () => {
    useDataFetchStore.getState().updateConsumptionStatus({ daily: 'loading', detail: 'loading' })

    hover()

    expect(screen.getByText('16/10/2023 → 15/10/2026 (3 ans)')).toBeTruthy()
    expect(screen.getByText('16/10/2024 → 15/10/2026 (2 ans)')).toBeTruthy()
  })
})
