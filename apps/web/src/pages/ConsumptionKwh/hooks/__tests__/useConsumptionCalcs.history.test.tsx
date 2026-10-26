import type { ReactNode } from 'react'
import { afterEach, describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useConsumptionCalcs } from '../useConsumptionCalcs'
import { useDatePreferencesStore } from '@/stores/datePreferencesStore'
import { HISTORY_END, HISTORY_START, dailyHistory, maxPowerHistory, sparseCurve } from '@/test/history'

const PDL = '99999999999991'

function renderCalcs(props: Partial<Parameters<typeof useConsumptionCalcs>[0]>, queryClient = new QueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(
    () =>
      useConsumptionCalcs({
        consumptionData: null,
        maxPowerData: null,
        detailData: null,
        selectedPDL: null,
        selectedPDLDetails: null,
        hcHpCalculationTrigger: 0,
        detailDateRange: null,
        ...props,
      }),
    { wrapper },
  )
}

const preset = useDatePreferencesStore.getState().preset
afterEach(() => useDatePreferencesStore.setState({ preset }))

// MED-64 : six ans de données locales (import V1), toutes les années doivent apparaître
describe('useConsumptionCalcs : historique de plus de 3 ans', () => {
  it('périodes glissantes : une par tranche de 365 jours de données, pas 3', () => {
    useDatePreferencesStore.setState({ preset: 'rolling' })
    const { result } = renderCalcs({ consumptionData: dailyHistory() })

    const labels = result.current.chartData.byYear.map((y: { year: string }) => y.year).sort()
    expect(labels).toEqual(['2021', '2022', '2023', '2024', '2025', '2026'])
  })

  it('courbe annuelle : toutes les années calendaires, pas 4', () => {
    const { result } = renderCalcs({ consumptionData: dailyHistory() })

    const labels = (result.current.chartData as any).yearsByPeriod.map((y: { label: string }) => y.label)
    expect(labels).toEqual(['2026', '2025', '2024', '2023', '2022', '2021', '2020'])
  })

  it('preset calendaire : un bloc par année ayant des données, pas 3', () => {
    useDatePreferencesStore.setState({ preset: 'calendar' })
    const { result } = renderCalcs({ consumptionData: dailyHistory() })

    const labels = (result.current.chartData as any).byYearPreset.map((y: { year: string }) => y.year)
    expect(labels).toEqual(['2026', '2025', '2024', '2023', '2022', '2021', '2020'])
  })

  it('puissance max : toutes les années calendaires, pas 4', () => {
    const { result } = renderCalcs({ maxPowerData: maxPowerHistory() })

    expect(result.current.powerByYearData.map((y) => y.label)).toEqual(['2026', '2025', '2024', '2023', '2022', '2021', '2020'])
  })

  it('HC/HP : une période glissante par an de courbe de charge, pas 3', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['consumptionDetail', PDL, HISTORY_START, HISTORY_END], { data: sparseCurve() })

    const { result } = renderCalcs(
      { selectedPDL: PDL, selectedPDLDetails: { offpeak_hours: { ranges: ['22:00-06:00'] } } },
      queryClient,
    )

    expect(result.current.hcHpByYear).toHaveLength(6)
    expect(result.current.hcHpByYear.every((p) => p.hcKwh > 0)).toBe(true)
  })
})
