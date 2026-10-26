import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { enedisApi } from '@/api/enedis'
import { logger } from '@/utils/logger'
import { buildMeasure, getIntervalLength, getReadings, getUnit } from '@/utils/enedisMeasure'
import { toast } from '@/stores/notificationStore'
import type { MeasureReading, PDL } from '@/types/api'
import { useDataFetchStore } from '@/stores/dataFetchStore'
import { useCacheBroadcast } from './useCacheBroadcast'
import { historyStartDate, oldestLocalDate, type LocalSyncStatus } from '@/utils/historyRange'
import { loadLocalSyncStatus } from '@/utils/localSyncStatus'

interface UseUnifiedDataFetchParams {
  selectedPDL: string
  selectedPDLDetails: PDL | undefined
  allPDLs: PDL[]
  /** Context de la page pour déterminer quelles données récupérer */
  pageContext: 'consumption' | 'production' | 'all'
}


export interface FetchAllDataOptions {
  /** Récupération de fond (rafraîchissement automatique du mode client, MED-68) : aucun toast */
  silent?: boolean
}

const noop = () => undefined
const silentToast = { success: noop, error: noop, warning: noop, info: noop, loading: () => '', dismiss: noop }

export function useUnifiedDataFetch({
  selectedPDL,
  selectedPDLDetails,
  allPDLs,
  pageContext,
}: UseUnifiedDataFetchParams) {
  const queryClient = useQueryClient()
  const { updateConsumptionStatus, updateProductionStatus, resetLoadingStatus } = useDataFetchStore()
  const { broadcast } = useCacheBroadcast()

  const fetchAllData = useCallback(async ({ silent = false }: FetchAllDataOptions = {}) => {
    const notify = silent ? silentToast : toast

    if (!selectedPDL || !selectedPDLDetails) {
      notify.error('Veuillez sélectionner un PDL')
      return
    }

    // Reset all statuses
    resetLoadingStatus()

    // Calculate dates using LOCAL time for user's perspective (France timezone)
    // This ensures that at 0h30 local time, "yesterday" is still the previous calendar day
    const now = new Date()
    const yesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      12, 0, 0, 0  // Use noon to avoid DST edge cases
    )

    const today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      12, 0, 0, 0
    )

    const threeYearsAgo = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate() - 1095,
      12, 0, 0, 0
    )

    const twoYearsAgo = new Date(
      today.getFullYear() - 2,
      today.getMonth(),
      today.getDate(),
      12, 0, 0, 0
    )

    const formatDate = (date: Date) => {
      return date.getFullYear() + '-' +
             String(date.getMonth() + 1).padStart(2, '0') + '-' +
             String(date.getDate()).padStart(2, '0')
    }

    const endDate = formatDate(yesterday)
    const startDate3y = formatDate(threeYearsAgo)
    const startDate2y = formatDate(twoYearsAgo)

    // Un seul statut de synchro par PDL et par chargement (conso et production peuvent partager le PDL)
    const syncStatuses = new Map<string, Promise<LocalSyncStatus | null>>()
    const localStatus = (usagePointId: string) => {
      if (!syncStatuses.has(usagePointId)) syncStatuses.set(usagePointId, loadLocalSyncStatus(usagePointId))
      return syncStatuses.get(usagePointId)!
    }

    logger.log('Starting unified data fetch:', {
      pdl: selectedPDL,
      pageContext,
      hasConsumption: selectedPDLDetails.has_consumption,
      hasProduction: selectedPDLDetails.has_production,
      linkedProductionPdl: selectedPDLDetails.linked_production_pdl_id,
    })

    // Prepare all fetch promises to run in parallel
    const fetchPromises: Promise<void>[] = []

    // Determine what data to fetch based on page context
    const shouldFetchConsumption = (pageContext === 'consumption' || pageContext === 'all') && selectedPDLDetails.has_consumption

    // On consumption page, also fetch production if PDL has production capability (direct or linked)
    const hasProductionCapability = selectedPDLDetails.has_production || !!selectedPDLDetails.linked_production_pdl_id
    const shouldFetchProduction = pageContext === 'production' || pageContext === 'all' || (pageContext === 'consumption' && hasProductionCapability)

    logger.log('Data fetch decisions:', { shouldFetchConsumption, shouldFetchProduction, hasProductionCapability })

    // === CONSUMPTION DATA ===
    if (shouldFetchConsumption) {
      const consumptionStatus = await localStatus(selectedPDL)
      const consumptionDailyStart = historyStartDate(startDate3y, oldestLocalDate(consumptionStatus, 'consumption_daily'))
      const maxPowerStart = historyStartDate(startDate3y, oldestLocalDate(consumptionStatus, 'max_power_daily'))
      const consumptionDetailStart = historyStartDate(startDate2y, oldestLocalDate(consumptionStatus, 'consumption_detailed'))

      // Invalidate existing consumption queries
      queryClient.invalidateQueries({ queryKey: ['consumptionDaily', selectedPDL] })
      queryClient.invalidateQueries({ queryKey: ['maxPower', selectedPDL] })

      // Fetch consumption daily data (3 years, or all local history)
      updateConsumptionStatus({ daily: 'loading', dailyRange: { start: consumptionDailyStart, end: endDate } })
      fetchPromises.push(
        (async () => {
          try {
            logger.log(`Fetching consumption daily: ${consumptionDailyStart} → ${endDate}`)
            const dailyData = await enedisApi.getConsumptionDaily(selectedPDL, {
              start: consumptionDailyStart,
              end: endDate,
              use_cache: true,
            })

            if (dailyData?.success) {
              queryClient.setQueryData(['consumptionDaily', selectedPDL], dailyData)
              updateConsumptionStatus({ daily: 'success' })
              logger.log('Consumption daily data fetched successfully')
            } else {
              updateConsumptionStatus({ daily: 'error' })
            }
          } catch (error: any) {
            logger.log('Error fetching consumption daily:', error)
            updateConsumptionStatus({ daily: 'error' })
            notify.error(`Erreur données quotidiennes de consommation: ${error?.response?.data?.error?.message || error.message}`)
          }
        })()
      )

      // Fetch max power data (3 years, or all local history)
      updateConsumptionStatus({ powerMax: 'loading', powerMaxRange: { start: maxPowerStart, end: endDate } })
      fetchPromises.push(
        (async () => {
          try {
            logger.log(`Fetching max power: ${maxPowerStart} → ${endDate}`)
            const powerData = await enedisApi.getMaxPower(selectedPDL, {
              start: maxPowerStart,
              end: endDate,
              use_cache: true,
            })

            if (powerData?.success) {
              queryClient.setQueryData(['maxPower', selectedPDL], powerData)
              updateConsumptionStatus({ powerMax: 'success' })
              logger.log('Max power data fetched successfully')
            } else {
              updateConsumptionStatus({ powerMax: 'error' })
            }
          } catch (error: any) {
            logger.log('Error fetching max power:', error)
            updateConsumptionStatus({ powerMax: 'error' })
            // Don't show error for power max - it's optional
          }
        })()
      )

      // Fetch consumption detail batch (2 years, or all local history)
      updateConsumptionStatus({ detail: 'loading', detailProgress: { current: 0, total: 1 }, detailRange: { start: consumptionDetailStart, end: endDate } })
      fetchPromises.push(
        (async () => {
          try {
            logger.log(`Fetching consumption detail batch: ${consumptionDetailStart} → ${endDate}`)
            const batchData = await enedisApi.getConsumptionDetailBatch(selectedPDL, {
              start: consumptionDetailStart,
              end: endDate,
              use_cache: true,
            })

            if (batchData?.success && batchData.data) {
              const readings = getReadings(batchData.data)

              // Deduplicate readings using a Map with timestamp as key
              const uniqueReadingsMap = new Map<string, MeasureReading>()
              readings.forEach((point) => {
                uniqueReadingsMap.set(point.date, point)
              })
              const uniqueReadings = Array.from(uniqueReadingsMap.values())

              // Store all detail data in a single cache key
              queryClient.setQueryData(['consumptionDetail', selectedPDL], {
                success: true,
                data: buildMeasure(uniqueReadings, {
                  grandeurMetier: 'CONS',
                  unite: getUnit(batchData.data) || 'W',
                  pas: getIntervalLength(batchData.data),
                  start: consumptionDetailStart,
                  end: endDate,
                })
              })

              // Calculate period statistics for toast
              const dates = new Set(uniqueReadings.map((p) => p.date.split(' ')[0].split('T')[0]))
              const dayCount = dates.size
              const years = Math.floor(dayCount / 365)
              const remainingDays = dayCount % 365
              const yearsText = years > 0 ? `${years} an${years > 1 ? 's' : ''}` : ''
              const daysText = remainingDays > 0 ? `${remainingDays} jour${remainingDays > 1 ? 's' : ''}` : ''
              const periodText = [yearsText, daysText].filter(Boolean).join(' et ')

              updateConsumptionStatus({
                detail: 'success',
                detailProgress: { current: 1, total: 1 }
              })

              notify.success(`Consommation détaillée: ${periodText}, ${uniqueReadings.length} points`, { duration: 4000 })
            } else if (batchData?.error) {
              updateConsumptionStatus({ detail: 'error' })
              if (batchData.error.code === 'PARTIAL_DATA') {
                notify.warning(batchData.error.message, { duration: 4000 })
              } else {
                notify.error(batchData.error.message || 'Erreur données détaillées de consommation')
              }
            }
          } catch (error: any) {
            logger.log('Error fetching consumption detail batch:', error)
            updateConsumptionStatus({ detail: 'error' })
            notify.error(`Erreur données détaillées de consommation: ${error?.response?.data?.error?.message || error.message}`)
          }
        })()
      )
    }

    // === PRODUCTION DATA ===
    // Only fetch production data when on production page or 'all' context
    // For linked production PDLs, ONLY fetch production data (never consumption)
    if (shouldFetchProduction) {
      // Determine which PDL to use for production data
      let productionPdlUsagePointId: string | null = null

      if (selectedPDLDetails.has_production) {
        // This PDL has production capability
        productionPdlUsagePointId = selectedPDL
      } else if (selectedPDLDetails.linked_production_pdl_id) {
        // This is a consumption PDL linked to a production PDL
        // Find the production PDL in the list to get its usage_point_id
        const productionPDL = allPDLs.find(p => p.id === selectedPDLDetails.linked_production_pdl_id)
        if (productionPDL) {
          productionPdlUsagePointId = productionPDL.usage_point_id
          logger.log(`Using linked production PDL: ${productionPdlUsagePointId} (only production data, not consumption)`)
        }
      }

    if (productionPdlUsagePointId) {
      const productionStatus = await localStatus(productionPdlUsagePointId)
      const productionDailyStart = historyStartDate(startDate3y, oldestLocalDate(productionStatus, 'production_daily'))
      const productionDetailStart = historyStartDate(startDate2y, oldestLocalDate(productionStatus, 'production_detailed'))

      logger.log(`Fetching production data for PDL: ${productionPdlUsagePointId}`)

      // Invalidate existing production queries
      queryClient.invalidateQueries({ queryKey: ['productionDaily', productionPdlUsagePointId] })

      // Fetch production daily data (3 years, or all local history)
      updateProductionStatus({ daily: 'loading', dailyRange: { start: productionDailyStart, end: endDate } })
      fetchPromises.push(
        (async () => {
          try {
            logger.log(`Fetching production daily: ${productionDailyStart} → ${endDate}`)
            const dailyData = await enedisApi.getProductionDaily(productionPdlUsagePointId, {
              start: productionDailyStart,
              end: endDate,
              use_cache: true,
            })

            if (dailyData?.success) {
              queryClient.setQueryData(['productionDaily', productionPdlUsagePointId], dailyData)
              updateProductionStatus({ daily: 'success' })
              logger.log('Production daily data fetched successfully')
            } else {
              updateProductionStatus({ daily: 'error' })
            }
          } catch (error: any) {
            logger.log('Error fetching production daily:', error)
            updateProductionStatus({ daily: 'error' })
            notify.error(`Erreur données quotidiennes de production: ${error?.response?.data?.error?.message || error.message}`)
          }
        })()
      )

      // Fetch production detail batch (2 years, or all local history)
      updateProductionStatus({ detail: 'loading', detailProgress: { current: 0, total: 1 }, detailRange: { start: productionDetailStart, end: endDate } })
      fetchPromises.push(
        (async () => {
          try {
            logger.log(`Fetching production detail batch: ${productionDetailStart} → ${endDate}`)
            const batchData = await enedisApi.getProductionDetailBatch(productionPdlUsagePointId, {
              start: productionDetailStart,
              end: endDate,
              use_cache: true,
            })

            if (batchData?.success && batchData.data) {
              const readings = getReadings(batchData.data)

              // Deduplicate readings using a Map with timestamp as key
              const uniqueReadingsMap = new Map<string, MeasureReading>()
              readings.forEach((point) => {
                uniqueReadingsMap.set(point.date, point)
              })
              const uniqueReadings = Array.from(uniqueReadingsMap.values())

              // Store all detail data in a single cache key
              queryClient.setQueryData(['productionDetail', productionPdlUsagePointId], {
                success: true,
                data: buildMeasure(uniqueReadings, {
                  grandeurMetier: 'PROD',
                  unite: getUnit(batchData.data) || 'W',
                  pas: getIntervalLength(batchData.data),
                  start: productionDetailStart,
                  end: endDate,
                })
              })

              // Calculate period statistics for toast
              const dates = new Set(uniqueReadings.map((p) => p.date.split(' ')[0].split('T')[0]))
              const dayCount = dates.size
              const years = Math.floor(dayCount / 365)
              const remainingDays = dayCount % 365
              const yearsText = years > 0 ? `${years} an${years > 1 ? 's' : ''}` : ''
              const daysText = remainingDays > 0 ? `${remainingDays} jour${remainingDays > 1 ? 's' : ''}` : ''
              const periodText = [yearsText, daysText].filter(Boolean).join(' et ')

              updateProductionStatus({
                detail: 'success',
                detailProgress: { current: 1, total: 1 }
              })

              notify.success(`Production détaillée: ${periodText}, ${uniqueReadings.length} points`, { duration: 4000 })
            } else if (batchData?.error) {
              updateProductionStatus({ detail: 'error' })
              if (batchData.error.code === 'PARTIAL_DATA') {
                notify.warning(batchData.error.message, { duration: 4000 })
              } else {
                notify.error(batchData.error.message || 'Erreur données détaillées de production')
              }
            }
          } catch (error: any) {
            logger.log('Error fetching production detail batch:', error)
            updateProductionStatus({ detail: 'error' })
            notify.error(`Erreur données détaillées de production: ${error?.response?.data?.error?.message || error.message}`)
          }
        })()
      )
    }
    } // End of shouldFetchProduction block

    // Wait for all fetch promises to complete in parallel
    await Promise.all(fetchPromises)

    logger.log('Unified data fetch completed')

    // Show a toast to indicate cache persistence is happening
    const persistToast = notify.loading('💾 Mise en cache des données...', { duration: 3000 })

    // Wait a bit for React Query Persist to save to localStorage
    // This gives time for the persistence mechanism to complete
    setTimeout(() => {
      notify.dismiss(persistToast)
      notify.success('✅ Données mises en cache avec succès !', { duration: 3000 })

      // Broadcast cache update to other tabs
      logger.log('[UnifiedFetch] Broadcasting CACHE_UPDATED to other tabs')
      broadcast({
        type: 'CACHE_UPDATED',
        timestamp: Date.now(),
        source: 'unified-fetch'
      })
      logger.log('[UnifiedFetch] Broadcast sent')
    }, 1500)
  }, [selectedPDL, selectedPDLDetails, allPDLs, pageContext, queryClient, updateConsumptionStatus, updateProductionStatus, resetLoadingStatus, broadcast])

  return {
    fetchAllData,
  }
}
