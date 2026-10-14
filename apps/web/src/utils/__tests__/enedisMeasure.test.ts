import { describe, it, expect } from 'vitest'
import {
  getReadings,
  getUnit,
  getIntervalLength,
  hasReadings,
  buildMeasure,
  getContractSummary,
  getAddressSummary,
  intervalToHours,
  readingEnergyWh,
  resamplePowerKw,
} from '../enedisMeasure'
import { dayReadings, mixedCurve } from '@/test/loadCurve'

const measure2026 = {
  idPrm: '99999999999991',
  periode: { dateDebut: '2026-09-29', dateFin: '2026-09-30' },
  grandeur: [
    {
      grandeurMetier: 'CONS',
      grandeurPhysique: 'PA',
      unite: 'W',
      points: [
        { v: '4078', d: '2026-09-29 00:00:00', p: 'PT30M' },
        { v: '2848', d: '2026-09-29 00:30:00', p: 'PT30M' },
      ],
    },
  ],
}

// Réponse v5 encore présente dans le cache React Query restauré depuis IndexedDB
const measureV5 = {
  meter_reading: {
    reading_type: { unit: 'Wh', interval_length: 'P1D' },
    interval_reading: [{ value: '33495', date: '2026-09-29' }],
  },
}

describe('enedisMeasure — mesures', () => {
  it('lit les points 2026 en lectures numériques', () => {
    expect(getReadings(measure2026)).toEqual([
      { date: '2026-09-29 00:00:00', value: 4078, interval_length: 'PT30M' },
      { date: '2026-09-29 00:30:00', value: 2848, interval_length: 'PT30M' },
    ])
  })

  it('lit encore le format v5', () => {
    expect(getReadings(measureV5)).toEqual([{ date: '2026-09-29', value: 33495 }])
    expect(getUnit(measureV5)).toBe('Wh')
    expect(getIntervalLength(measureV5)).toBe('P1D')
  })

  it('unité et pas en 2026', () => {
    expect(getUnit(measure2026)).toBe('W')
    expect(getIntervalLength(measure2026)).toBe('PT30M')
  })

  it('réponse vide ou erreur', () => {
    expect(getReadings(undefined)).toEqual([])
    expect(getReadings({ error: 'ADAM-ERR0123' })).toEqual([])
    expect(hasReadings({ grandeur: [] })).toBe(false)
    expect(hasReadings(measure2026)).toBe(true)
  })

  it('reconstruit une réponse 2026 depuis des lectures', () => {
    const rebuilt = buildMeasure(getReadings(measure2026), { grandeurMetier: 'CONS', unite: 'W' })
    expect(getReadings(rebuilt)).toEqual(getReadings(measure2026))
    expect(rebuilt.grandeur?.[0].points[0]).toEqual({ v: '4078', d: '2026-09-29 00:00:00', p: 'PT30M' })
  })
})

describe('enedisMeasure — contrat et adresse', () => {
  it('retient le contrat de soutirage et les heures creuses', () => {
    const contract = {
      situation_contrat: [
        { contract_type: 'Contrat GRD-A', segment: 'P4' },
        {
          contract_type: 'Contrat GRD-F',
          segment: 'C5',
          distribution_tariff: 'Tarif BT<=36kVA',
          subscribed_power: { value: '12', unit: 'kVA' },
        },
      ],
      synthese_contrat: { consumption_last_activation_date: '2014-01-22T00:00:00+0100' },
      comptage: { relais: { plageHeuresCreuses: 'HC (22H00-6H00)' } },
    }
    expect(getContractSummary(contract)).toEqual({
      segment: 'C5',
      contractType: 'Contrat GRD-F',
      subscribedPower: '12 kVA',
      distributionTariff: 'Tarif BT<=36kVA',
      offpeakHours: 'HC (22H00-6H00)',
      lastActivationDate: '2014-01-22',
    })
  })

  it('contrat v5', () => {
    const v5 = { customer: { usage_points: [{ contracts: { segment: 'C5', subscribed_power: '6 kVA', offpeak_hours: 'HC (2H00-7H00)' } }] } }
    expect(getContractSummary(v5)).toMatchObject({ segment: 'C5', subscribedPower: '6 kVA', offpeakHours: 'HC (2H00-7H00)' })
  })

  it('adresse 2026 et v5', () => {
    expect(getAddressSummary({ address: { number_street_name: '1 RUE X', postal_code_city: '75001 PARIS', insee_code: '75101' } })).toEqual({
      street: '1 RUE X',
      postalCodeCity: '75001 PARIS',
      inseeCode: '75101',
    })
    const v5 = { customer: { usage_points: [{ usage_point: { usage_point_addresses: { street: '2 RUE Y', postal_code: '59000', city: 'LILLE', insee_code: '59350' } } }] } }
    expect(getAddressSummary(v5)).toEqual({ street: '2 RUE Y', postalCodeCity: '59000 LILLE', inseeCode: '59350' })
  })
})

describe('enedisMeasure — revue MED-14', () => {
  it('ignore les points sans valeur (trou de courbe, pas de NaN)', () => {
    const data = {
      grandeur: [
        {
          grandeurMetier: 'PROD',
          grandeurPhysique: 'PA',
          unite: 'W',
          points: [{ v: '500', d: '2026-09-29 00:00:00' }, { v: null, d: '2026-09-29 00:30:00' }, { d: '2026-09-29 01:00:00' }],
        },
      ],
    }
    expect(getReadings(data)).toEqual([{ date: '2026-09-29 00:00:00', value: 500 }])
    expect(getReadings({ meter_reading: { interval_reading: [{ value: '', date: 'x' }, { value: '0', date: 'y' }] } })).toEqual([
      { date: 'y', value: 0 },
    ])
  })

  it('PRM producteur seul : date de mise en service de la production', () => {
    const summary = getContractSummary({
      situation_contrat: [{ contract_type: 'Contrat GRD-A', segment: 'P4' }],
      synthese_contrat: { generation_last_activation_date: '2024-07-31T00:00:00+0200' },
    })
    expect(summary?.lastActivationDate).toBe('2024-07-31')
  })
})

// MED-24 : chaque relevé compte pour son propre pas (courbe à pas mixte, compteur reconfiguré)
describe('enedisMeasure — pas et énergie par relevé', () => {
  it('convertit un pas en heures', () => {
    expect(intervalToHours('PT10M')).toBeCloseTo(1 / 6)
    expect(intervalToHours('PT15M')).toBe(0.25)
    expect(intervalToHours('PT30M')).toBe(0.5)
    expect(intervalToHours('PT60M')).toBe(1)
    expect(intervalToHours('PT1H')).toBe(1)
    expect(intervalToHours('P1D')).toBe(24)
  })

  it('pas absent ou illisible : undefined, sans deviner', () => {
    expect(intervalToHours(undefined)).toBeUndefined()
    expect(intervalToHours('')).toBeUndefined()
    expect(intervalToHours('sont à ')).toBeUndefined()
  })

  it('puissance (W) × pas du relevé, prioritaire sur le pas par défaut', () => {
    expect(readingEnergyWh({ date: 'x', value: 1000, interval_length: 'PT10M' }, 'W', 'PT30M')).toBeCloseTo(1000 / 6)
    expect(readingEnergyWh({ date: 'x', value: 1000, interval_length: 'PT15M' }, 'W', 'PT30M')).toBe(250)
  })

  it('relevé sans pas : pas par défaut, sinon 30 min (pas historique Enedis)', () => {
    expect(readingEnergyWh({ date: 'x', value: 1000 }, 'W', 'PT15M')).toBe(250)
    expect(readingEnergyWh({ date: 'x', value: 1000 }, 'W')).toBe(500)
    expect(readingEnergyWh({ date: 'x', value: 1000 }, 'W', 'illisible')).toBe(500)
  })

  it('valeur déjà en énergie (Wh) : inchangée, quel que soit le pas', () => {
    expect(readingEnergyWh({ date: 'x', value: 33495, interval_length: 'P1D' }, 'Wh')).toBe(33495)
    expect(readingEnergyWh({ date: 'x', value: 120, interval_length: 'PT30M' }, 'WH')).toBe(120)
  })

  it('courbe mixte 48×PT30M + 144×PT10M à 1000 W : 48 kWh', () => {
    const readings = getReadings(mixedCurve())
    const totalWh = readings.reduce((sum, r) => sum + readingEnergyWh(r, 'W', getIntervalLength(mixedCurve())), 0)
    expect(readings).toHaveLength(192)
    expect(totalWh / 1000).toBeCloseTo(48)
  })
})

describe('enedisMeasure — courbe de comparaison sur les créneaux du jour affiché', () => {
  const times = (pas: 'PT10M' | 'PT30M') => dayReadings('2026-09-29', pas, 0).map((r) => r.date.slice(11, 16))

  it('même pas : puissance moyenne en kW, créneau par créneau', () => {
    const power = resamplePowerKw(dayReadings('2026-09-22', 'PT30M', 1000), times('PT30M'), 'W')
    expect(power).toHaveLength(48)
    expect(power.every((kw) => kw !== null && Math.abs(kw - 1) < 1e-9)).toBe(true)
  })

  it('comparaison plus fine (PT10M) sur un jour en PT30M : un pic de 10 min reste dans son créneau', () => {
    const readings = dayReadings('2026-09-22', 'PT10M', 0).map((r) =>
      r.date.endsWith('00:10:00') ? { ...r, value: 6000 } : r,
    )
    const power = resamplePowerKw(readings, times('PT30M'), 'W')
    // 6 kW pendant 10 min sur un créneau de 30 min : 2 kW de moyenne, énergie conservée
    expect(power[0]).toBeCloseTo(2)
    expect(power[1]).toBeCloseTo(0)
  })

  it('comparaison plus grossière (PT30M) sur un jour en PT10M : chaque créneau reçoit sa valeur', () => {
    const power = resamplePowerKw(dayReadings('2026-09-22', 'PT30M', 1000), times('PT10M'), 'W')
    expect(power).toHaveLength(144)
    expect(power.every((kw) => kw !== null && Math.abs(kw - 1) < 1e-9)).toBe(true)
  })

  it('créneau non couvert par la comparaison : null', () => {
    const power = resamplePowerKw(dayReadings('2026-09-22', 'PT30M', 1000).slice(0, 2), times('PT30M'), 'W')
    expect(power[0]).toBeCloseTo(1)
    expect(power[2]).toBeNull()
  })

  it('énergie (Wh) ramenée à une puissance moyenne', () => {
    const power = resamplePowerKw([{ date: '2026-09-22T10:00:00', value: 250, interval_length: 'PT15M' }], ['10:00', '10:15'], 'Wh')
    expect(power[0]).toBeCloseTo(1)
  })
})
