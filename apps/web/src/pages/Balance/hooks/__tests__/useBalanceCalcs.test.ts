import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBalanceCalcs } from '../useBalanceCalcs'
import { DAY_1, DAY_2, dailyMeasure, dayReadings, loadCurve, mixedCurve } from '@/test/loadCurve'

// MED-24 : l'autoconsommation fine compare conso et production relevé par relevé, en W
describe('useBalanceCalcs : courbe de charge à pas mixte', () => {
  const consumptionDaily = dailyMeasure('CONS', 24000)
  const productionDaily = dailyMeasure('PROD', 24000)

  it('chaque relevé compte pour son pas (PT30M puis PT10M) : 50 % autoconsommés', () => {
    // 24 kWh produits chaque jour, consommés le premier jour seulement
    const production = mixedCurve('PROD', 'PT30M', 'PT10M')
    const consumption = loadCurve([...dayReadings(DAY_1, 'PT30M', 1000), ...dayReadings(DAY_2, 'PT10M', 0)])

    const { result } = renderHook(() => useBalanceCalcs(consumptionDaily, productionDaily, consumption, production))

    // Pas du premier point appliqué partout : 24 / (24 + 72) = 25 %
    expect(result.current?.totals.selfConsumptionRate).toBeCloseTo(50)
  })

  it('même chose dans l\'ordre inverse (PT10M puis PT30M)', () => {
    const production = mixedCurve('PROD', 'PT10M', 'PT30M')
    const consumption = loadCurve([...dayReadings(DAY_1, 'PT10M', 1000), ...dayReadings(DAY_2, 'PT30M', 0)])

    const { result } = renderHook(() => useBalanceCalcs(consumptionDaily, productionDaily, consumption, production))

    // Pas du premier point appliqué partout : 24 / (24 + 8) = 75 %
    expect(result.current?.totals.selfConsumptionRate).toBeCloseTo(50)
  })

  it('totaux quotidiens (Wh) inchangés', () => {
    const { result } = renderHook(() => useBalanceCalcs(consumptionDaily, productionDaily))

    expect(result.current?.totals.consumption).toBe(48000)
    expect(result.current?.totals.production).toBe(48000)
    expect(result.current?.byDay.map((d) => d.date)).toEqual([DAY_1, DAY_2])
  })
})
