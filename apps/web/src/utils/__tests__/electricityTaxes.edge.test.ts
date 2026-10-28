import { describe, it, expect } from 'vitest'
import { acciseRate, monthTaxBreakdown, sumTaxBreakdown } from '../electricityTaxes'

const parts = (b: ReturnType<typeof monthTaxBreakdown>) => b.energyHT + b.accise + b.subscriptionHT + b.vat

describe('cas limites du détail des taxes', () => {
  it('énergie HT négative (heures gratuites) : les parties reconstituent toujours le TTC', () => {
    const b = monthTaxBreakdown({ month: '2026-09', totalKwh: 300, consumptionCost: 0, subscriptionCost: 10 })
    expect(b.energyHT).toBeLessThan(0)
    expect(parts(b)).toBeCloseTo(b.totalTTC, 9)
  })

  it('avant 2016 : accise à 0, tout le HT reste dans l\'énergie', () => {
    const b = monthTaxBreakdown({ month: '2015-12', totalKwh: 100, consumptionCost: 24, subscriptionCost: 0 })
    expect(b.accise).toBe(0)
    expect(b.energyHT).toBeCloseTo(20, 9)
  })

  it('bornes de mois : la veille et le jour d\'effet de chaque changement de tarif', () => {
    expect(acciseRate('2016-01')).toBe(0.0225)
    expect(acciseRate('2022-01')).toBe(0.0225)
    expect(acciseRate('2025-01')).toBe(0.021)
    expect(acciseRate('2026-07')).toBe(0.03085)
  })

  it('mois sans consommation ni abonnement : zéros, pas de NaN', () => {
    const b = monthTaxBreakdown({ month: '2026-01', totalKwh: 0, consumptionCost: 0, subscriptionCost: 0 })
    expect(Object.values(b).every((v) => v === 0)).toBe(true)
  })

  it('période à cheval sur le 1er août 2025 : chaque mois garde son taux d\'abonnement', () => {
    const t = sumTaxBreakdown([
      { month: '2025-07', totalKwh: 0, consumptionCost: 0, subscriptionCost: 10.55 },
      { month: '2025-08', totalKwh: 0, consumptionCost: 0, subscriptionCost: 12 },
    ])
    expect(t.vatSubscription).toBeCloseTo(0.55 + 2, 9)
  })
})
