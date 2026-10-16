import { queryOptions } from '@tanstack/react-query'
import { energyApi, type EnergyOffer } from './energy'

/**
 * Offers including closed ones (inactive or valid_to in the past), needed to find a PDL's offer
 * even after its price grid has been closed (MED-67).
 *
 * Single definition of this cache entry: every reader of ['energy-offers', 'with-history'] must
 * go through it, so the cache always holds EnergyOffer[] whatever page filled it first.
 * Callers add their own staleTime / refetch options by spreading the result.
 */
export const offersWithHistoryQueryOptions = () =>
  queryOptions({
    queryKey: ['energy-offers', 'with-history'],
    queryFn: async (): Promise<EnergyOffer[]> => {
      const response = await energyApi.getOffers(undefined, true)
      return response.success && Array.isArray(response.data) ? response.data : []
    },
  })
