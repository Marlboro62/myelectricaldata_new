import { describe, it, expect } from 'vitest'
import { historyStartDate, oldestLocalDate, formatHistoryDepth } from '../historyRange'

// MED-64 : l'historique demandé part de la donnée locale la plus ancienne, jamais moins que la fenêtre Enedis
describe('historyStartDate', () => {
  const FENETRE = '2023-10-16'

  it('sans donnée locale connue : la fenêtre Enedis', () => {
    expect(historyStartDate(FENETRE, null)).toBe(FENETRE)
    expect(historyStartDate(FENETRE, undefined)).toBe(FENETRE)
  })

  it('donnée locale plus ancienne que la fenêtre (import V1) : on remonte jusqu\'à elle', () => {
    expect(historyStartDate(FENETRE, '2019-03-01')).toBe('2019-03-01')
  })

  it('donnée locale plus récente que la fenêtre : la fenêtre, pour que les trous soient comblés', () => {
    expect(historyStartDate(FENETRE, '2025-01-01')).toBe(FENETRE)
  })

  it('date locale illisible : la fenêtre', () => {
    expect(historyStartDate(FENETRE, 'pas-une-date')).toBe(FENETRE)
    expect(historyStartDate(FENETRE, '')).toBe(FENETRE)
  })
})

describe('oldestLocalDate', () => {
  const status = {
    usage_point_id: '99999999999991',
    sync_types: {
      consumption_daily: { oldest_data_date: '2019-03-01' },
      consumption_detailed: { oldest_data_date: null },
      max_power_daily: { oldest_data_date: '2019-03-02' },
    },
  }

  it('lit la borne du type demandé dans le statut de synchro', () => {
    expect(oldestLocalDate(status, 'consumption_daily')).toBe('2019-03-01')
    expect(oldestLocalDate(status, 'max_power_daily')).toBe('2019-03-02')
  })

  it('type sans borne, absent ou statut indisponible : null', () => {
    expect(oldestLocalDate(status, 'consumption_detailed')).toBeNull()
    expect(oldestLocalDate(status, 'production_daily')).toBeNull()
    expect(oldestLocalDate(null, 'consumption_daily')).toBeNull()
    expect(oldestLocalDate(undefined, 'consumption_daily')).toBeNull()
  })
})

describe('formatHistoryDepth', () => {
  it('en années, arrondi à l\'année la plus proche', () => {
    expect(formatHistoryDepth('2023-10-16', '2026-10-15')).toBe('3 ans')
    expect(formatHistoryDepth('2024-10-16', '2026-10-15')).toBe('2 ans')
    expect(formatHistoryDepth('2019-03-01', '2026-10-15')).toBe('8 ans')
    expect(formatHistoryDepth('2025-10-01', '2026-10-15')).toBe('1 an')
  })

  it('moins d\'un an : en mois', () => {
    expect(formatHistoryDepth('2026-02-15', '2026-10-15')).toBe('8 mois')
    expect(formatHistoryDepth('2026-10-01', '2026-10-15')).toBe('1 mois')
  })
})
