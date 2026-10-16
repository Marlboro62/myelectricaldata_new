/**
 * Profondeur d'historique demandée au backend (MED-64).
 *
 * Enedis ne sert que 3 ans de journalier et 2 ans de courbe de charge : c'est la fenêtre demandée par
 * défaut. En mode client, la base locale peut remonter bien plus loin (import de l'historique V1) :
 * on part alors de la donnée locale la plus ancienne, lue dans le statut de synchro du PDL.
 */

/** Clés `<data_type>_<granularité>` des statuts de synchro du client (GET /sync/status/{pdl}) */
export type SyncTypeKey =
  | 'consumption_daily'
  | 'consumption_detailed'
  | 'production_daily'
  | 'production_detailed'
  | 'max_power_daily'

/** Statut de synchro d'un PDL, réduit à ce qui borne l'historique */
export interface LocalSyncStatus {
  sync_types?: Record<string, { oldest_data_date?: string | null } | undefined>
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Début de la plage à demander : la donnée locale la plus ancienne si elle précède la fenêtre Enedis,
 * sinon la fenêtre elle-même (ses trous restent à combler par la passerelle).
 */
export function historyStartDate(windowStart: string, oldestLocal?: string | null): string {
  if (!oldestLocal || !ISO_DATE.test(oldestLocal)) return windowStart
  return oldestLocal < windowStart ? oldestLocal : windowStart
}

/** Donnée locale la plus ancienne d'un type, ou null (type jamais synchronisé, statut indisponible) */
export function oldestLocalDate(status: LocalSyncStatus | null | undefined, key: SyncTypeKey): string | null {
  return status?.sync_types?.[key]?.oldest_data_date ?? null
}

/** Profondeur lisible d'une plage YYYY-MM-DD : « 3 ans », « 1 an », « 8 mois » */
export function formatHistoryDepth(start: string, end: string): string {
  const days = (Date.parse(end) - Date.parse(start)) / DAY_MS
  if (days >= 350) {
    const years = Math.round(days / 365.25)
    return years === 1 ? '1 an' : `${years} ans`
  }
  return `${Math.max(1, Math.round(days / 30.44))} mois`
}

/**
 * Années glissantes, de la plus récente à la plus ancienne, jusqu'à couvrir `oldest` : autant que
 * l'historique en contient, sans plafond. Pas d'un an calendaire (pas de 365 jours, qui dérivent
 * d'un jour par année bissextile et finissent par donner deux périodes de même année de fin).
 * Bornes incluses et disjointes : chaque période commence juste après la fin de la précédente.
 * Calcul en UTC : les dates journalières sont à minuit UTC, et un pas en heure locale décalerait la borne
 * d'une heure quand l'état de l'heure d'été diffère d'une année à l'autre (un jour changerait de période).
 */
export function rollingYearPeriods(mostRecent: Date, oldest: Date): Array<{ start: Date; end: Date }> {
  const yearsBack = (years: number) => {
    const date = new Date(mostRecent)
    date.setUTCFullYear(mostRecent.getUTCFullYear() - years)
    return date
  }
  const periods: Array<{ start: Date; end: Date }> = []
  for (let i = 0; i === 0 || yearsBack(i) >= oldest; i++) {
    periods.push({ start: new Date(yearsBack(i + 1).getTime() + 1), end: yearsBack(i) })
  }
  return periods
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10)

/**
 * Morceaux de 365 jours au plus d'une plage [start, end[ (YYYY-MM-DD) pour les appels journaliers.
 * La fin de chaque appel est exclue par l'API (client local comme passerelle, comme dateFin Enedis) :
 * chaque morceau commence donc là où finit le précédent. Une fin incluse (`end - 1 jour`, puis le
 * suivant à `end + 1 jour`) perdrait un jour à chaque frontière.
 */
export function splitYearlyChunks(start: string, end: string): Array<{ start: string; end: string }> {
  const endMs = Date.parse(end)
  if (!(Date.parse(start) < endMs)) return [{ start, end }]
  const chunks: Array<{ start: string; end: string }> = []
  let current = new Date(start)
  while (current.getTime() < endMs) {
    const next = new Date(current.getTime() + 365 * DAY_MS)
    const chunkEnd = next.getTime() < endMs ? next : new Date(endMs)
    chunks.push({ start: isoDay(current), end: isoDay(chunkEnd) })
    current = chunkEnd
  }
  return chunks
}

/**
 * Premier jour sélectionnable dans le calendrier de la courbe de charge : la fenêtre Enedis (2 ans), ou la
 * donnée locale la plus ancienne quand la courbe en cache remonte plus loin (import V1, mode client).
 */
export function detailCalendarStart(windowStart: Date, availableDates: Iterable<string>): Date {
  let oldest: string | null = null
  for (const day of availableDates) {
    if (ISO_DATE.test(day) && (oldest === null || day < oldest)) oldest = day
  }
  if (oldest === null) return windowStart
  const oldestDate = new Date(oldest)
  return oldestDate < windowStart ? oldestDate : windowStart
}
