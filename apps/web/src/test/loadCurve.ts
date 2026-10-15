/**
 * Courbes de charge de test dont le pas change en cours de route (MED-24).
 *
 * Un compteur reconfiguré (PT30M → PT10M, ou passage en PT15M par Enedis) rend une
 * courbe à pas mixte : chaque relevé doit compter pour SON pas, pas celui du premier.
 */
import type { EnedisMeasure, MeasureReading } from '@/types/api'
import { buildMeasure } from '@/utils/enedisMeasure'

const MINUTES = { PT10M: 10, PT15M: 15, PT30M: 30 } as const
export type Pas = keyof typeof MINUTES

export const DAY_1 = '2026-09-29'
export const DAY_2 = '2026-09-30'

/** Relevés d'une journée complète, horodatés au DÉBUT de l'intervalle (décalage déjà fait par le backend) */
export function dayReadings(day: string, pas: Pas, watts: number): MeasureReading[] {
  const step = MINUTES[pas]
  return Array.from({ length: (24 * 60) / step }, (_, i) => {
    const minutes = i * step
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
    const mm = String(minutes % 60).padStart(2, '0')
    return { date: `${day} ${hh}:${mm}:00`, value: watts, interval_length: pas }
  })
}

/** Courbe de charge en W, sans pas global : getIntervalLength rend le pas du premier point */
export const loadCurve = (readings: MeasureReading[], grandeurMetier: 'CONS' | 'PROD' = 'CONS'): EnedisMeasure =>
  buildMeasure(readings, { grandeurMetier, unite: 'W' })

/**
 * Cas de la revue MED-14 : 48 points PT30M puis 144 points PT10M à 1000 W, soit 24 kWh par jour
 * et 48 kWh au total (96 kWh avec le pas du premier point appliqué partout, 32 dans l'ordre inverse).
 */
export const mixedCurve = (grandeurMetier: 'CONS' | 'PROD' = 'CONS', first: Pas = 'PT30M', second: Pas = 'PT10M') =>
  loadCurve([...dayReadings(DAY_1, first, 1000), ...dayReadings(DAY_2, second, 1000)], grandeurMetier)

/** Mesure quotidienne en Wh (pas P1D) sur les deux jours de la courbe mixte */
export const dailyMeasure = (grandeurMetier: 'CONS' | 'PROD', wh: number): EnedisMeasure =>
  buildMeasure(
    [
      { date: DAY_1, value: wh, interval_length: 'P1D' },
      { date: DAY_2, value: wh, interval_length: 'P1D' },
    ],
    { grandeurMetier, unite: 'Wh', pas: 'P1D' },
  )
