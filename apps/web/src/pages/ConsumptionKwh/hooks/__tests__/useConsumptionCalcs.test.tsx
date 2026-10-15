import type { ReactNode } from 'react'
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useConsumptionCalcs } from '../useConsumptionCalcs'
import { DAY_1, DAY_2, mixedCurve } from '@/test/loadCurve'

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

// MED-24 : courbe de consommation dont le pas change (PT30M puis PT10M)
describe('useConsumptionCalcs : courbe de charge à pas mixte', () => {
  it('courbe détaillée : 24 kWh par jour, chaque relevé comptant pour son pas', () => {
    const { result } = renderCalcs({ detailData: mixedCurve() })
    const byDate = Object.fromEntries(result.current.detailByDayData.map((d) => [d.date, d]))

    expect(byDate[DAY_1]?.data).toHaveLength(48)
    expect(byDate[DAY_2]?.data).toHaveLength(144)
    expect(byDate[DAY_1]?.totalEnergyKwh).toBeCloseTo(24)
    expect(byDate[DAY_2]?.totalEnergyKwh).toBeCloseTo(24)
    expect(byDate[DAY_2]?.data.every((p: { power: number }) => Math.abs(p.power - 1) < 1e-9)).toBe(true)
  })

  it('HC/HP depuis le cache des courbes détaillées : 48 kWh sur la période', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['consumptionDetail', PDL, DAY_1, DAY_2], { data: mixedCurve() })

    const { result } = renderCalcs({ selectedPDL: PDL }, queryClient)

    expect(result.current.hcHpByYear[0]?.totalKwh).toBeCloseTo(48)
  })
})
