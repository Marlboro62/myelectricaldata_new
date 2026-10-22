import { describe, it, expect } from 'vitest'
import { acciseRate, subscriptionVatRate, monthTaxBreakdown, sumTaxBreakdown } from '../electricityTaxes'

describe('acciseRate', () => {
  it('suit les dates d\'effet légales (ménages)', () => {
    expect(acciseRate('2021-12')).toBe(0.0225)
    expect(acciseRate('2022-02')).toBe(0.001)
    expect(acciseRate('2024-01')).toBe(0.001)
    expect(acciseRate('2024-02')).toBe(0.021)
    expect(acciseRate('2025-07')).toBe(0.0337)
    expect(acciseRate('2025-08')).toBe(0.02998)
    expect(acciseRate('2026-01')).toBe(0.02998)
    expect(acciseRate('2026-02')).toBe(0.03085)
    expect(acciseRate('2026-08')).toBe(0.03062)
  })

  it('vaut 0 avant le premier tarif connu', () => {
    expect(acciseRate('2015-06')).toBe(0)
  })
})

describe('subscriptionVatRate', () => {
  it('5,5 % avant le 1er août 2025, 20 % ensuite', () => {
    expect(subscriptionVatRate('2025-07')).toBe(0.055)
    expect(subscriptionVatRate('2025-08')).toBe(0.2)
    expect(subscriptionVatRate('2026-10')).toBe(0.2)
  })
})

describe('monthTaxBreakdown', () => {
  it('décompose un mois TTC en énergie HT, accise, abonnement HT et TVA', () => {
    // 300 kWh, 54 € TTC de consommation, 15,80 € TTC d'abonnement, en septembre 2026
    const b = monthTaxBreakdown({ month: '2026-09', totalKwh: 300, consumptionCost: 54, subscriptionCost: 15.8 })
    expect(b.accise).toBeCloseTo(300 * 0.03062, 6)
    expect(b.vatConsumption).toBeCloseTo(9, 6) // 54 - 54 / 1,2
    expect(b.energyHT).toBeCloseTo(45 - 9.186, 6)
    expect(b.subscriptionHT).toBeCloseTo(15.8 / 1.2, 6)
    expect(b.vat).toBeCloseTo(9 + (15.8 - 15.8 / 1.2), 6)
    // Les parties reconstituent exactement le TTC
    expect(b.energyHT + b.accise + b.subscriptionHT + b.vat).toBeCloseTo(b.totalTTC, 9)
    expect(b.totalTTC).toBeCloseTo(69.8, 9)
  })

  it('applique 5,5 % sur l\'abonnement avant août 2025', () => {
    const b = monthTaxBreakdown({ month: '2025-03', totalKwh: 0, consumptionCost: 0, subscriptionCost: 10.55 })
    expect(b.subscriptionHT).toBeCloseTo(10, 6)
    expect(b.vatSubscription).toBeCloseTo(0.55, 6)
  })
})

describe('sumTaxBreakdown', () => {
  it('additionne les mois, chacun avec son propre taux', () => {
    const months = [
      { month: '2026-01', totalKwh: 400, consumptionCost: 70, subscriptionCost: 15.8 },
      { month: '2026-02', totalKwh: 350, consumptionCost: 61, subscriptionCost: 15.8 },
    ]
    const total = sumTaxBreakdown(months)
    expect(total.kwh).toBe(750)
    expect(total.accise).toBeCloseTo(400 * 0.02998 + 350 * 0.03085, 6)
    expect(total.totalTTC).toBeCloseTo(70 + 15.8 + 61 + 15.8, 9)
    expect(total.energyHT + total.accise + total.subscriptionHT + total.vat).toBeCloseTo(total.totalTTC, 9)
  })

  it('renvoie des zéros sans mois', () => {
    expect(sumTaxBreakdown([]).totalTTC).toBe(0)
  })
})
