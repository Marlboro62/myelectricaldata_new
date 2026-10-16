import { useEffect, useRef } from 'react'
import { logger } from '@/utils/logger'
import { loadLocalSyncStatus } from '@/utils/localSyncStatus'

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
  sync_types: Record<string, { newest_data_date: string | null; oldest_data_date?: string | null } & Record<string, unknown>>
}

export const SYNC_SIGNATURE_KEY_PREFIX = 'myelectricaldata-sync-signature:'
export const AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1000

/**
 * Résume un statut de synchro en une chaîne stable, qui change seulement quand la plage de données
 * locale bouge : donnée plus récente (Enedis) ou plus ancienne (import V1, MED-64). `last_sync_at`
 * est écarté : il bouge à chaque passage du scheduler, même quand Enedis n'a rien publié.
 */
export function computeSyncSignature(status: PdlSyncStatus | null): string | null {
  const types = status?.sync_types
  if (!types || Object.keys(types).length === 0) return null

  return Object.keys(types)
    .sort()
    .map((key) => `${key}=${types[key]?.oldest_data_date ?? ''}..${types[key]?.newest_data_date ?? ''}`)
    .join('|')
}

/**
 * Décide s'il faut relancer la récupération
 *
 * - hasCache : le cache du navigateur contient déjà des données pour ce PDL
 * - previousSignature : signature mémorisée à la dernière récupération réussie (null si jamais)
 * - currentSignature : signature du statut de synchro lu à l'instant (null si illisible)
 */
export function shouldRefresh({
  hasCache,
  previousSignature,
  currentSignature,
}: {
  hasCache: boolean
  previousSignature: string | null
  currentSignature: string | null
}): boolean {
  // Nouvel appareil ou cache purgé : relire, même sans statut lisible (le backend comble les trous)
  if (!hasCache) return true
  // Statut illisible (404 avant la première synchro, backend injoignable) : rien de nouveau à attendre
  if (currentSignature === null) return false
  // Cache rempli avant cette version (aucune signature) ou synchro nouvelle
  return previousSignature !== currentSignature
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

// null en mode serveur, sur 404 (PDL jamais synchronisé) ou backend injoignable : statut illisible
async function readSyncStatus(usagePointId: string): Promise<PdlSyncStatus | null> {
  const status = (await loadLocalSyncStatus(usagePointId)) as PdlSyncStatus | null
  return status?.sync_types ? status : null
}

function readStoredSignature(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storeSignature(key: string, signature: string) {
  try {
    localStorage.setItem(key, signature)
  } catch {
    // localStorage indisponible (navigation privée stricte) : on relira au prochain passage
  }
}

export function useClientAutoRefresh({
  usagePointId,
  enabled,
  hasCachedData,
  refresh,
  intervalMs = AUTO_REFRESH_INTERVAL_MS,
}: UseClientAutoRefreshParams): void {
  // Refs : les callbacks changent à chaque rendu de PageHeader, l'effet ne doit pas repartir pour autant
  const hasCachedDataRef = useRef(hasCachedData)
  const refreshRef = useRef(refresh)
  hasCachedDataRef.current = hasCachedData
  refreshRef.current = refresh

  // Partagé entre le montage, l'intervalle et le retour sur l'onglet : une seule récupération à la fois
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!enabled || !usagePointId) return

    let cancelled = false
    const storageKey = SYNC_SIGNATURE_KEY_PREFIX + usagePointId

    const check = async () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        const currentSignature = computeSyncSignature(await readSyncStatus(usagePointId))
        if (cancelled) return

        const decision = shouldRefresh({
          hasCache: hasCachedDataRef.current(),
          previousSignature: readStoredSignature(storageKey),
          currentSignature,
        })
        if (!decision) return

        logger.log('[AutoRefresh] Récupération automatique', { usagePointId, currentSignature })
        await refreshRef.current()

        // fetchAllData avale ses erreurs : un cache encore vide après coup veut dire que rien n'est
        // arrivé, on ne mémorise pas la signature pour retenter au prochain passage
        if (!cancelled && currentSignature && hasCachedDataRef.current()) {
          storeSignature(storageKey, currentSignature)
        }
      } finally {
        inFlightRef.current = false
      }
    }

    check()
    const timer = setInterval(check, intervalMs)
    // Les timers sont suspendus quand l'onglet passe en arrière-plan (mobile surtout)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, usagePointId, intervalMs])
}
