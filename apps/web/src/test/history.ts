/**
 * Historique long de test (MED-64) : six ans de données locales, comme après un import V1.
 *
 * Enedis ne sert que 3 ans de journalier et 2 ans de courbe de charge, mais la base du client
 * local garde tout ce que la V1 avait accumulé : le front doit l'afficher en entier.
 */
import type { EnedisMeasure, MeasureReading } from '@/types/api'
import { buildMeasure } from '@/utils/enedisMeasure'

/** Dernier jour de données (J-1 d'un « aujourd'hui » au 2026-10-15) */
export const HISTORY_END = '2026-10-14'
/** Six périodes glissantes de 365 jours pile avant HISTORY_END */
export const HISTORY_START = '2020-10-16'

/** Jours (YYYY-MM-DD) de from à to inclus */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  const current = new Date(`${from}T00:00:00Z`)
  const last = new Date(`${to}T00:00:00Z`)
  while (current <= last) {
    days.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return days
}

/** Journalier en Wh, une valeur constante par jour */
export const dailyHistory = (
  grandeurMetier: 'CONS' | 'PROD' = 'CONS',
  wh = 10000,
  from = HISTORY_START,
  to = HISTORY_END,
): EnedisMeasure =>
  buildMeasure(
    daysBetween(from, to).map((date): MeasureReading => ({ date, value: wh, interval_length: 'P1D' })),
    { grandeurMetier, unite: 'Wh', pas: 'P1D' },
  )

/** Puissance max quotidienne en VA, pic à 18:42 chaque jour */
export const maxPowerHistory = (va = 6100, from = HISTORY_START, to = HISTORY_END): EnedisMeasure =>
  buildMeasure(
    daysBetween(from, to).map((day): MeasureReading => ({ date: `${day} 18:42:00`, value: va, interval_length: 'P1D' })),
    { grandeurMetier: 'CONS', unite: 'VA', grandeurPhysique: 'PMA', pas: 'P1D' },
  )

/** Courbe de charge clairsemée (un point PT30M à 03:00 par jour, 1000 W) : léger, mais présent sur tout l'historique */
export const sparseCurve = (from = HISTORY_START, to = HISTORY_END): EnedisMeasure =>
  buildMeasure(
    daysBetween(from, to).map((day): MeasureReading => ({ date: `${day} 03:00:00`, value: 1000, interval_length: 'PT30M' })),
    { grandeurMetier: 'CONS', unite: 'W' },
  )
