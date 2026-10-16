import { queryOptions } from '@tanstack/react-query'
import { energyApi, type EnergyOffer, type EnergyProvider } from './energy'

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

/**
 * Active providers. Same single-definition rule as above: the cache under ['energy-providers']
 * always holds EnergyProvider[] (MED-67 review).
 */
export const providersQueryOptions = () =>
  queryOptions({
    queryKey: ['energy-providers'],
    queryFn: async (): Promise<EnergyProvider[]> => {
      const response = await energyApi.getProviders()
      return response.success && Array.isArray(response.data) ? response.data : []
    },
  })
