import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useProductionCalcs } from '../useProductionCalcs'
import { dailyHistory } from '@/test/history'

// MED-64 : six ans de production locale (import V1), toutes les années doivent apparaître
describe('useProductionCalcs : historique de plus de 3 ans', () => {
  const render = () => renderHook(() => useProductionCalcs({ productionData: dailyHistory('PROD', 8000), detailData: null }))

  it('périodes glissantes : une par tranche de 365 jours de données, pas 3', () => {
    const { result } = render()

    const labels = result.current.chartData.byYear.map((y: { year: string }) => y.year).sort()
    expect(labels).toEqual(['2021', '2022', '2023', '2024', '2025', '2026'])
  })

  it('courbe annuelle : une entrée par période', () => {
    const { result } = render()

    expect((result.current.chartData as any).yearsByPeriod).toHaveLength(6)
  })
})
