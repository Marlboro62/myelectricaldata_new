import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useProductionCalcs } from '../useProductionCalcs'
import { DAY_1, DAY_2, mixedCurve } from '@/test/loadCurve'

// MED-24 : courbe de production dont le pas change (PT30M puis PT10M)
describe('useProductionCalcs : courbe détaillée à pas mixte', () => {
  const render = () => renderHook(() => useProductionCalcs({ productionData: null, detailData: mixedCurve('PROD') }))

  it('24 kWh par jour, chaque relevé comptant pour son pas', () => {
    const { result } = render()
    const byDate = Object.fromEntries(result.current.detailByDayData.map((d) => [d.date, d]))

    expect(byDate[DAY_1]?.totalEnergyKwh).toBeCloseTo(24)
    expect(byDate[DAY_2]?.totalEnergyKwh).toBeCloseTo(24)
    // Puissance moyenne de chaque relevé : 1000 W = 1 kW, quel que soit le pas
    expect(byDate[DAY_2]?.data.every((p) => Math.abs(p.power - 1) < 1e-9)).toBe(true)
  })

  it('horodatages déjà au début de l\'intervalle : pas de second décalage côté front', () => {
    const { result } = render()
    const byDate = Object.fromEntries(result.current.detailByDayData.map((d) => [d.date, d]))

    // Le backend (shift_points_to_interval_start) a déjà reculé chaque point de son pas
    expect(byDate[DAY_1]?.data).toHaveLength(48)
    expect(byDate[DAY_1]?.data[0].time).toBe('00:00')
    expect(byDate[DAY_2]?.data).toHaveLength(144)
    expect(byDate[DAY_2]?.data[0].time).toBe('00:00')
    expect(byDate[DAY_2]?.data[143].time).toBe('23:50')
  })
})
