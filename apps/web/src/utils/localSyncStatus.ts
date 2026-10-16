/**
 * Statut de synchro local d'un PDL (mode client) : sa donnée la plus ancienne borne l'historique
 * demandé, au-delà de la fenêtre Enedis (import V1, MED-64).
 */
import { syncApi } from '@/api/sync'
import { getAppMode } from '@/hooks/useAppMode'
import { logger } from '@/utils/logger'
import { historyStartDate, oldestLocalDate, type LocalSyncStatus, type SyncTypeKey } from './historyRange'

/** Statut de synchro du PDL, en mode client seulement ; indisponible ou mode serveur : null */
export async function loadLocalSyncStatus(usagePointId: string): Promise<LocalSyncStatus | null> {
  if (getAppMode() !== 'client') return null
  try {
    // La route renvoie le statut nu, sans enveloppe APIResponse
    return (await syncApi.getStatusPdl(usagePointId)) as unknown as LocalSyncStatus
  } catch (error) {
    logger.log(`Sync status unavailable for ${usagePointId}, keeping Enedis windows:`, error)
    return null
  }
}

/** Début de plage d'un type : la fenêtre Enedis, ou plus tôt si la base locale remonte plus loin */
export async function resolveHistoryStart(usagePointId: string, windowStart: string, key: SyncTypeKey): Promise<string> {
  return historyStartDate(windowStart, oldestLocalDate(await loadLocalSyncStatus(usagePointId), key))
}
