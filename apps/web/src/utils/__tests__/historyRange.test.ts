import { describe, it, expect } from 'vitest'
import {
  historyStartDate,
  oldestLocalDate,
  formatHistoryDepth,
  rollingYearPeriods,
  splitYearlyChunks,
  detailCalendarStart,
} from '../historyRange'

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

describe('rollingYearPeriods', () => {
  it('autant de périodes que l historique en contient, de la plus récente à la plus ancienne', () => {
    const periods = rollingYearPeriods(new Date('2026-10-14'), new Date('2020-10-16'))

    expect(periods.map((p) => p.end.getFullYear())).toEqual([2026, 2025, 2024, 2023, 2022, 2021])
  })

  it('une seule période quand l historique tient dans l année', () => {
    expect(rollingYearPeriods(new Date('2026-10-14'), new Date('2026-03-01'))).toHaveLength(1)
  })

  it('bornes disjointes et contiguës : aucun jour compté deux fois', () => {
    const periods = rollingYearPeriods(new Date('2026-10-14'), new Date('2022-01-01'))

    periods.slice(1).forEach((p, i) => expect(periods[i].start.getTime() - p.end.getTime()).toBe(1))
  })

  it('fin au 31 décembre après une année bissextile : années de fin toutes distinctes', () => {
    const years = rollingYearPeriods(new Date(2026, 11, 31), new Date(2019, 0, 1)).map((p) => p.end.getFullYear())

    expect(new Set(years).size).toBe(years.length)
  })

  it('bornes à minuit UTC quel que soit l état de l heure d été (dates journalières)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const periods = rollingYearPeriods(new Date('2026-10-26'), new Date('2020-01-01'))

    periods.forEach((p) => expect(p.end.getTime() % DAY_MS).toBe(0))
    expect(periods[1].end.toISOString()).toBe('2025-10-26T00:00:00.000Z')
  })
})

// MED-64 : fin incluse côté interface (toExclusiveEnd ajoute un jour à l'appel) : les morceaux se suivent sans se chevaucher
describe('splitYearlyChunks', () => {
  const days = (start: string, end: string) => {
    const out: string[] = []
    for (let t = Date.parse(start); t <= Date.parse(end); t += 24 * 60 * 60 * 1000) out.push(new Date(t).toISOString().slice(0, 10))
    return out
  }

  it('couvre chaque jour de [start, end] une seule fois, 29 février compris', () => {
    const chunks = splitYearlyChunks('2019-03-01', '2026-10-15')
    const covered = chunks.flatMap((c) => days(c.start, c.end))

    expect(chunks[0].start).toBe('2019-03-01')
    expect(chunks[chunks.length - 1].end).toBe('2026-10-15')
    expect(covered).toEqual(days('2019-03-01', '2026-10-15'))
    expect(covered.filter((d) => d === '2020-02-29')).toHaveLength(1)
  })

  it('chaque morceau reprend au lendemain de la fin du précédent', () => {
    const chunks = splitYearlyChunks('2019-03-01', '2026-10-15')

    chunks.slice(1).forEach((c, i) => expect(days(chunks[i].end, c.start)).toHaveLength(2))
  })

  it('365 jours au plus par morceau', () => {
    splitYearlyChunks('2019-03-01', '2026-10-15').forEach((c) => expect(days(c.start, c.end).length).toBeLessThanOrEqual(365))
  })

  it('plage courte, d un jour ou inversée : un seul morceau tel quel', () => {
    expect(splitYearlyChunks('2026-01-01', '2026-10-15')).toEqual([{ start: '2026-01-01', end: '2026-10-15' }])
    expect(splitYearlyChunks('2026-10-15', '2026-10-15')).toEqual([{ start: '2026-10-15', end: '2026-10-15' }])
    expect(splitYearlyChunks('2026-10-17', '2026-10-15')).toEqual([{ start: '2026-10-17', end: '2026-10-15' }])
  })
})

// MED-64 : le calendrier de la courbe de charge ouvre jusqu à la donnée locale la plus ancienne
describe('detailCalendarStart', () => {
  const twoYearsAgo = new Date('2024-10-15')

  it('sans donnée plus ancienne que la fenêtre Enedis : la fenêtre', () => {
    expect(detailCalendarStart(twoYearsAgo, new Set())).toEqual(twoYearsAgo)
    expect(detailCalendarStart(twoYearsAgo, new Set(['2025-03-01', '2026-10-14']))).toEqual(twoYearsAgo)
  })

  it('courbe importée plus ancienne : le premier jour disponible', () => {
    expect(detailCalendarStart(twoYearsAgo, new Set(['2026-10-14', '2020-06-01', '2020-05-31']))).toEqual(new Date('2020-05-31'))
  })

  it('ignore une date illisible', () => {
    expect(detailCalendarStart(twoYearsAgo, new Set(['n/a', '']))).toEqual(twoYearsAgo)
  })
})
