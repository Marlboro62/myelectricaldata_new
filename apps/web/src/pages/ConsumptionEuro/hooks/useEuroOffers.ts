import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { offersWithHistoryQueryOptions, providersQueryOptions } from '@/api/energyQueries'
import { isOfferExpired } from '@/utils/offers'
import type { SelectedOfferWithProvider } from '../types/euro.types'

interface UseEuroOffersParams {
  selectedOfferId: string | null | undefined
  comparisonOfferId: string | null
}

export function useEuroOffers({ selectedOfferId, comparisonOfferId }: UseEuroOffersParams) {
  // Fetch providers
  const { data: providersData } = useQuery({
    ...providersQueryOptions(),
    staleTime: 5 * 60 * 1000,
  })

  // Fetch all offers, closed ones included: the PDL's offer may have a valid_to in the past (MED-67)
  const { data: offersData, isLoading: isLoadingOffers } = useQuery({
    ...offersWithHistoryQueryOptions(),
    staleTime: 5 * 60 * 1000,
  })

  const providers = useMemo(() => providersData || [], [providersData])
  const allOffers = useMemo(() => offersData || [], [offersData])

  // Get selected offer with provider name
  const selectedOfferWithProvider = useMemo((): SelectedOfferWithProvider | null => {
    if (!selectedOfferId) return null

    const offer = allOffers.find(o => o.id === selectedOfferId)
    if (!offer) return null

    const provider = providers.find(p => p.id === offer.provider_id)

    return {
      ...offer,
      providerName: provider?.name || 'Fournisseur inconnu'
    }
  }, [selectedOfferId, allOffers, providers])

  // Get comparison offer (for display only, doesn't change PDL's main offer)
  const comparisonOfferWithProvider = useMemo((): SelectedOfferWithProvider | null => {
    if (!comparisonOfferId) return null

    const offer = allOffers.find(o => o.id === comparisonOfferId)
    if (!offer) return null

    const provider = providers.find(p => p.id === offer.provider_id)

    return {
      ...offer,
      providerName: provider?.name || 'Fournisseur inconnu'
    }
  }, [comparisonOfferId, allOffers, providers])

  const isSelectedOfferClosed = selectedOfferWithProvider ? isOfferExpired(selectedOfferWithProvider) : false

  // Filter compatible offers for comparison: current offers with the same power_kva as the selected
  // offer, plus the PDL's own offer even when closed (kept as "Actuelle" in the dropdown)
  const compatibleOffers = useMemo(() => {
    const power = selectedOfferWithProvider?.power_kva
    return allOffers.filter(o => {
      if (o.id === selectedOfferId) return true
      if (isOfferExpired(o)) return false
      return !power || o.power_kva === power
    })
  }, [allOffers, selectedOfferId, selectedOfferWithProvider?.power_kva])

  return {
    providers,
    isLoadingOffers,
    selectedOfferWithProvider,
    comparisonOfferWithProvider,
    compatibleOffers,
    isSelectedOfferClosed,
  }
}
