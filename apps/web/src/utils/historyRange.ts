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
