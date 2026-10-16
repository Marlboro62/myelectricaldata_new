/**
 * Rafraîchissement automatique des données en mode client (MED-68)
 *
 * En mode client, le scheduler du backend synchronise les données dans la base locale,
 * mais les pages n'affichent que le cache React Query du navigateur (IndexedDB), rempli
 * par « Récupérer ». Ce hook surveille le statut de synchro du PDL et relance la
 * récupération quand de nouvelles données sont arrivées, ou quand le cache est vide.
 */

/** Statut de synchro d'un PDL, tel que renvoyé par GET /sync/status/{pdl} */
export interface PdlSyncStatus {
  usage_point_id: string
  sync_types: Record<string, { newest_data_date: string | null } & Record<string, unknown>>
}

export const SYNC_SIGNATURE_KEY_PREFIX = 'myelectricaldata-sync-signature:'
export const AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1000

/** Résume un statut de synchro en une chaîne stable, qui change seulement quand une donnée plus récente arrive */
export function computeSyncSignature(_status: PdlSyncStatus | null): string | null {
  return null
}

/** Décide s'il faut relancer la récupération */
export function shouldRefresh(_params: {
  hasCache: boolean
  previousSignature: string | null
  currentSignature: string | null
}): boolean {
  return false
}

export interface UseClientAutoRefreshParams {
  usagePointId: string | null
  /** Faux en mode serveur, en démo, ou tant que le PDL n'est pas chargé */
  enabled: boolean
  /** Le cache du navigateur contient-il déjà des données pour ce PDL ? */
  hasCachedData: () => boolean
  /** Récupération silencieuse (fetchAllData sans toast) */
  refresh: () => Promise<void>
  intervalMs?: number
}

export function useClientAutoRefresh(_params: UseClientAutoRefreshParams): void {}
