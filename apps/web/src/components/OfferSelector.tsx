import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Building2, Zap, Tag, X, AlertTriangle, Loader2, ChevronDown, Search } from 'lucide-react'
import { energyApi, EnergyOffer } from '@/api/energy'
import { offersWithHistoryQueryOptions } from '@/api/energyQueries'
import { isOfferExpired } from '@/utils/offers'

interface OfferSelectorProps {
  selectedOfferId: string | null | undefined
  subscribedPower: number | null | undefined
  onChange: (offerId: string | null) => void
  disabled?: boolean
  className?: string
  showExpired?: boolean
  onHasExpiredOffersChange?: (has: boolean) => void
}

// Mapping from offer_type to French label
const OFFER_TYPE_LABELS: Record<string, string> = {
  'BASE': 'Base',
  'HC_HP': 'Heures Creuses / Pleines',
  'BASE_WEEKEND': 'Week-end - Base',
  'HC_WEEKEND': 'Week-end - HC/HP',
  'HC_NUIT_WEEKEND': 'Week-end - Nuit',
  'WEEKEND': 'Week-end',
  'TEMPO': 'Tempo',
  'EJP': 'EJP',
  'SEASONAL': 'Saisonnier',
  'ZEN_FLEX': 'Zen Flex',
}

// Groupes de types d'offres pour le dropdown
const OFFER_TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: 'Classique', types: ['BASE', 'HC_HP'] },
  { label: 'Week-end', types: ['BASE_WEEKEND', 'HC_WEEKEND', 'HC_NUIT_WEEKEND', 'WEEKEND'] },
  { label: 'Modulable', types: ['TEMPO', 'SEASONAL', 'EJP', 'ZEN_FLEX'] },
]

export default function OfferSelector({
  selectedOfferId,
  subscribedPower,
  onChange,
  disabled = false,
  className = '',
  showExpired: showExpiredProp,
  onHasExpiredOffersChange,
}: OfferSelectorProps) {
  // States locaux pour les overrides manuels de l'utilisateur.
  // Quand l'utilisateur change un sélecteur, on stocke son choix ici.
  // Quand une offre est déjà sélectionnée (selectedOfferId), ces valeurs
  // sont ignorées au profit des valeurs dérivées de l'offre.
  const [userProviderId, setUserProviderId] = useState<string | null>(null)
  const [userOfferType, setUserOfferType] = useState<string | null>(null)
  const showExpired = showExpiredProp ?? false

  // Fetch providers
  // refetchOnMount: 'always' force un fetch frais à chaque mount pour éviter
  // les sélecteurs vides quand les données ne sont pas en cache (bug race condition)
  // placeholderData: garde les données précédentes pendant un refetch
  const { data: providersResponse, isLoading: isLoadingProviders, isFetching: isFetchingProviders } = useQuery({
    queryKey: ['energy-providers'],
    queryFn: energyApi.getProviders,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: 'always',
    placeholderData: keepPreviousData,
  })

  // Fetch all offers (incluant les offres périmées pour permettre leur sélection)
  const { data: offersData, isLoading: isLoadingOffers, isFetching: isFetchingOffers } = useQuery({
    ...offersWithHistoryQueryOptions(),
    staleTime: 5 * 60 * 1000,
    refetchOnMount: 'always',
    placeholderData: keepPreviousData,
  })

  // Stabilize providers and offers arrays
  const providers = useMemo(() => providersResponse?.data || [], [providersResponse?.data])
  const allOffers = useMemo(() => offersData || [], [offersData])

  // Find selected offer details
  const selectedOffer = useMemo(() => {
    if (!selectedOfferId) return null
    return allOffers.find(o => o.id === selectedOfferId) || null
  }, [selectedOfferId, allOffers])

  // Détecter si l'offre sélectionnée est périmée (pour le style du résumé)
  const isSelectedOfferExpired = selectedOffer ? isOfferExpired(selectedOffer) : false

  // Offres filtrées par puissance uniquement (base pour tous les sélecteurs)
  const powerFilteredOffers = useMemo(() => {
    return allOffers.filter(offer => {
      if (subscribedPower && offer.power_kva && offer.power_kva !== subscribedPower) return false
      return true
    })
  }, [allOffers, subscribedPower])

  // Valeurs effectives des sélecteurs : dérivées de l'offre sélectionnée
  // si elle existe, sinon des choix manuels de l'utilisateur.
  // Cela élimine le besoin d'un useEffect pour synchroniser les states.
  const effectiveProviderId = useMemo(() => {
    if (selectedOffer) return selectedOffer.provider_id
    return userProviderId
  }, [selectedOffer, userProviderId])

  const effectiveOfferType = useMemo(() => {
    if (selectedOffer) return selectedOffer.offer_type
    return userOfferType
  }, [selectedOffer, userOfferType])

  // Offres visibles selon le toggle (toujours toutes si showExpired, sinon actives uniquement)
  // Exception : si l'offre sélectionnée est périmée, on inclut toujours les périmées
  const effectiveShowExpired = showExpired || isSelectedOfferExpired
  const visibleOffers = useMemo(() => {
    if (effectiveShowExpired) return powerFilteredOffers
    return powerFilteredOffers.filter(o => !isOfferExpired(o))
  }, [powerFilteredOffers, effectiveShowExpired])

  // Détecte s'il existe des offres périmées (pour afficher/masquer le toggle)
  const hasExpiredOffers = useMemo(() => {
    return powerFilteredOffers.some(o => isOfferExpired(o))
  }, [powerFilteredOffers])

  // Notifie le parent quand hasExpiredOffers change
  useEffect(() => {
    onHasExpiredOffersChange?.(hasExpiredOffers)
  }, [hasExpiredOffers, onHasExpiredOffersChange])

  // Get providers that have offers
  // Inclut toujours le provider de l'offre sélectionnée pour éviter
  // que le changement de visibilité (toggle périmées) ne vide le sélecteur
  const availableProviders = useMemo(() => {
    const providerIds = new Set(visibleOffers.map(o => o.provider_id))
    // Inclure le provider sélectionné même s'il n'a pas d'offres visibles
    if (effectiveProviderId) providerIds.add(effectiveProviderId)
    return providers
      .filter(p => providerIds.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [visibleOffers, providers, effectiveProviderId])

  // Get offer types available for effective provider
  // Inclut toujours le type de l'offre sélectionnée pour stabilité du sélecteur
  const availableOfferTypes = useMemo(() => {
    if (!effectiveProviderId) return []
    const types = new Set(
      visibleOffers
        .filter(o => o.provider_id === effectiveProviderId)
        .map(o => o.offer_type)
    )
    // Inclure le type sélectionné même s'il n'est plus dans les offres visibles
    if (effectiveOfferType) types.add(effectiveOfferType)
    return Array.from(types).sort()
  }, [visibleOffers, effectiveProviderId, effectiveOfferType])

  // Get offers for effective provider and offer type
  // Inclut toujours l'offre sélectionnée pour éviter qu'elle disparaisse du dropdown
  const availableOffers = useMemo(() => {
    if (!effectiveProviderId || !effectiveOfferType) return []
    const filtered = visibleOffers
      .filter(o => o.provider_id === effectiveProviderId && o.offer_type === effectiveOfferType)
    // Inclure l'offre sélectionnée même si elle n'est pas dans les offres visibles
    if (selectedOffer && selectedOffer.provider_id === effectiveProviderId && selectedOffer.offer_type === effectiveOfferType) {
      if (!filtered.some(o => o.id === selectedOffer.id)) {
        filtered.push(selectedOffer)
      }
    }
    return filtered.sort((a, b) => a.name.localeCompare(b.name))
  }, [visibleOffers, effectiveProviderId, effectiveOfferType, selectedOffer])

  // Reset offer type and clear selected offer when provider changes manually
  const handleProviderChange = (providerId: string | null) => {
    setUserProviderId(providerId)
    setUserOfferType(null)
    if (selectedOfferId) onChange(null)
  }

  // Auto-sélection du premier type quand le provider change (et pas d'offre sélectionnée)
  useEffect(() => {
    if (effectiveProviderId && !selectedOffer && !effectiveOfferType) {
      const types = visibleOffers
        .filter(o => o.provider_id === effectiveProviderId)
        .map(o => o.offer_type)
      const uniqueTypes = Array.from(new Set(types)).sort()
      if (uniqueTypes.length > 0) {
        setUserOfferType(uniqueTypes[0])
      }
    }
  }, [effectiveProviderId, effectiveOfferType, selectedOffer, visibleOffers])

  // Auto-sélection de la première offre quand le type est défini (et pas d'offre sélectionnée)
  useEffect(() => {
    if (effectiveProviderId && effectiveOfferType && !selectedOffer && !selectedOfferId) {
      const offers = visibleOffers
        .filter(o => o.provider_id === effectiveProviderId && o.offer_type === effectiveOfferType)
        .filter(o => !isOfferExpired(o))
        .sort((a, b) => a.name.localeCompare(b.name))
      if (offers.length > 0) {
        onChange(offers[0].id)
      }
    }
  }, [effectiveProviderId, effectiveOfferType, selectedOffer, selectedOfferId, visibleOffers])

  // Reset offer when type changes manually
  // Avant de désélectionner l'offre, on sauvegarde le provider actuel
  // dans userProviderId pour qu'il survive à la perte de selectedOffer
  const handleOfferTypeChange = (offerType: string | null) => {
    if (selectedOffer) {
      setUserProviderId(selectedOffer.provider_id)
    }
    setUserOfferType(offerType)
    if (selectedOfferId) onChange(null)
  }

  // Handle offer selection
  // Sauvegarde provider + type avant de changer d'offre, pour que les
  // sélecteurs parents restent stables si la nouvelle offre est null
  const handleOfferChange = (offerId: string | null) => {
    if (selectedOffer && !offerId) {
      setUserProviderId(selectedOffer.provider_id)
      setUserOfferType(selectedOffer.offer_type)
    }
    onChange(offerId)
  }

  // Clear all selections
  const handleClear = () => {
    setUserProviderId(null)
    setUserOfferType(null)
    onChange(null)
  }

  const isLoading = isLoadingProviders || isLoadingOffers
  // Détecte quand une offre est sélectionnée en base mais pas encore résolue
  // (données en cours de chargement ou placeholder stale via keepPreviousData)
  const isOfferUnresolved = !!selectedOfferId && !selectedOffer && (isFetchingProviders || isFetchingOffers)

  // Format price for display (in €/kWh)
  const formatPrice = (price: number | string | undefined | null): string => {
    if (price === undefined || price === null) return '-'
    const numPrice = typeof price === 'string' ? parseFloat(price) : price
    if (isNaN(numPrice)) return '-'
    return `${numPrice.toFixed(4)} €/kWh`
  }

  // Format subscription price
  const formatSubscription = (price: number | string | undefined | null): string => {
    if (price === undefined || price === null) return '-'
    const numPrice = typeof price === 'string' ? parseFloat(price) : price
    if (isNaN(numPrice)) return '-'
    return `${numPrice.toFixed(2)} €/mois`
  }

  // Get detailed prices for selected offer summary
  const getDetailedPrices = (offer: EnergyOffer): React.ReactNode => {
    const priceRows: React.ReactNode[] = []

    // Base offers
    if (offer.offer_type === 'BASE' && offer.base_price !== undefined && offer.base_price !== null) {
      priceRows.push(
        <div key="base" className="flex justify-between">
          <span className="text-gray-600 dark:text-gray-400">Prix kWh:</span>
          <span className="font-medium">{formatPrice(offer.base_price)}</span>
        </div>
      )
    }

    // HP/HC offers
    if (offer.offer_type === 'HC_HP') {
      if (offer.hp_price !== undefined && offer.hp_price !== null) {
        priceRows.push(
          <div key="hp" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Heures Pleines:</span>
            <span className="font-medium">{formatPrice(offer.hp_price)}</span>
          </div>
        )
      }
      if (offer.hc_price !== undefined && offer.hc_price !== null) {
        priceRows.push(
          <div key="hc" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Heures Creuses:</span>
            <span className="font-medium">{formatPrice(offer.hc_price)}</span>
          </div>
        )
      }
    }

    // Tempo offers
    if (offer.offer_type === 'TEMPO') {
      // Jours Bleus
      if (offer.tempo_blue_hp !== undefined && offer.tempo_blue_hp !== null) {
        priceRows.push(
          <div key="blue-hp" className="flex justify-between">
            <span className="text-blue-600 dark:text-blue-400">Bleu HP:</span>
            <span className="font-medium">{formatPrice(offer.tempo_blue_hp)}</span>
          </div>
        )
      }
      if (offer.tempo_blue_hc !== undefined && offer.tempo_blue_hc !== null) {
        priceRows.push(
          <div key="blue-hc" className="flex justify-between">
            <span className="text-blue-600 dark:text-blue-400">Bleu HC:</span>
            <span className="font-medium">{formatPrice(offer.tempo_blue_hc)}</span>
          </div>
        )
      }
      // Jours Blancs
      if (offer.tempo_white_hp !== undefined && offer.tempo_white_hp !== null) {
        priceRows.push(
          <div key="white-hp" className="flex justify-between">
            <span className="text-gray-700 dark:text-gray-300">Blanc HP:</span>
            <span className="font-medium">{formatPrice(offer.tempo_white_hp)}</span>
          </div>
        )
      }
      if (offer.tempo_white_hc !== undefined && offer.tempo_white_hc !== null) {
        priceRows.push(
          <div key="white-hc" className="flex justify-between">
            <span className="text-gray-700 dark:text-gray-300">Blanc HC:</span>
            <span className="font-medium">{formatPrice(offer.tempo_white_hc)}</span>
          </div>
        )
      }
      // Jours Rouges
      if (offer.tempo_red_hp !== undefined && offer.tempo_red_hp !== null) {
        priceRows.push(
          <div key="red-hp" className="flex justify-between">
            <span className="text-red-600 dark:text-red-400">Rouge HP:</span>
            <span className="font-medium">{formatPrice(offer.tempo_red_hp)}</span>
          </div>
        )
      }
      if (offer.tempo_red_hc !== undefined && offer.tempo_red_hc !== null) {
        priceRows.push(
          <div key="red-hc" className="flex justify-between">
            <span className="text-red-600 dark:text-red-400">Rouge HC:</span>
            <span className="font-medium">{formatPrice(offer.tempo_red_hc)}</span>
          </div>
        )
      }
    }

    // EJP offers
    if (offer.offer_type === 'EJP') {
      if (offer.ejp_normal !== undefined && offer.ejp_normal !== null) {
        priceRows.push(
          <div key="ejp-normal" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Jours normaux:</span>
            <span className="font-medium">{formatPrice(offer.ejp_normal)}</span>
          </div>
        )
      }
      if (offer.ejp_peak !== undefined && offer.ejp_peak !== null) {
        priceRows.push(
          <div key="ejp-peak" className="flex justify-between">
            <span className="text-orange-600 dark:text-orange-400">Jours de pointe (EJP):</span>
            <span className="font-medium">{formatPrice(offer.ejp_peak)}</span>
          </div>
        )
      }
    }

    // Weekend offers
    if (offer.offer_type === 'WEEKEND') {
      // Weekday prices
      if (offer.hp_price !== undefined && offer.hp_price !== null) {
        priceRows.push(
          <div key="week-hp" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Semaine HP:</span>
            <span className="font-medium">{formatPrice(offer.hp_price)}</span>
          </div>
        )
      }
      if (offer.hc_price !== undefined && offer.hc_price !== null) {
        priceRows.push(
          <div key="week-hc" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Semaine HC:</span>
            <span className="font-medium">{formatPrice(offer.hc_price)}</span>
          </div>
        )
      }
      // Weekend prices
      if (offer.hp_price_weekend !== undefined && offer.hp_price_weekend !== null) {
        priceRows.push(
          <div key="weekend-hp" className="flex justify-between">
            <span className="text-purple-600 dark:text-purple-400">Week-end HP:</span>
            <span className="font-medium">{formatPrice(offer.hp_price_weekend)}</span>
          </div>
        )
      }
      if (offer.hc_price_weekend !== undefined && offer.hc_price_weekend !== null) {
        priceRows.push(
          <div key="weekend-hc" className="flex justify-between">
            <span className="text-purple-600 dark:text-purple-400">Week-end HC:</span>
            <span className="font-medium">{formatPrice(offer.hc_price_weekend)}</span>
          </div>
        )
      }
      // Base weekend price if exists
      if (offer.base_price_weekend !== undefined && offer.base_price_weekend !== null) {
        priceRows.push(
          <div key="weekend-base" className="flex justify-between">
            <span className="text-purple-600 dark:text-purple-400">Week-end:</span>
            <span className="font-medium">{formatPrice(offer.base_price_weekend)}</span>
          </div>
        )
      }
    }

    // Seasonal offers
    if (offer.offer_type === 'SEASONAL') {
      // Winter prices
      if (offer.hp_price_winter !== undefined && offer.hp_price_winter !== null) {
        priceRows.push(
          <div key="winter-hp" className="flex justify-between">
            <span className="text-cyan-600 dark:text-cyan-400">Hiver HP:</span>
            <span className="font-medium">{formatPrice(offer.hp_price_winter)}</span>
          </div>
        )
      }
      if (offer.hc_price_winter !== undefined && offer.hc_price_winter !== null) {
        priceRows.push(
          <div key="winter-hc" className="flex justify-between">
            <span className="text-cyan-600 dark:text-cyan-400">Hiver HC:</span>
            <span className="font-medium">{formatPrice(offer.hc_price_winter)}</span>
          </div>
        )
      }
      // Summer prices
      if (offer.hp_price_summer !== undefined && offer.hp_price_summer !== null) {
        priceRows.push(
          <div key="summer-hp" className="flex justify-between">
            <span className="text-amber-600 dark:text-amber-400">Été HP:</span>
            <span className="font-medium">{formatPrice(offer.hp_price_summer)}</span>
          </div>
        )
      }
      if (offer.hc_price_summer !== undefined && offer.hc_price_summer !== null) {
        priceRows.push(
          <div key="summer-hc" className="flex justify-between">
            <span className="text-amber-600 dark:text-amber-400">Été HC:</span>
            <span className="font-medium">{formatPrice(offer.hc_price_summer)}</span>
          </div>
        )
      }
      // Peak day price
      if (offer.peak_day_price !== undefined && offer.peak_day_price !== null) {
        priceRows.push(
          <div key="peak-day" className="flex justify-between">
            <span className="text-red-600 dark:text-red-400">Jours de pointe:</span>
            <span className="font-medium">{formatPrice(offer.peak_day_price)}</span>
          </div>
        )
      }
    }

    // If no specific prices found, try generic fallbacks
    if (priceRows.length === 0) {
      if (offer.base_price !== undefined && offer.base_price !== null) {
        priceRows.push(
          <div key="base-fallback" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Prix kWh:</span>
            <span className="font-medium">{formatPrice(offer.base_price)}</span>
          </div>
        )
      }
      if (offer.hp_price !== undefined && offer.hp_price !== null) {
        priceRows.push(
          <div key="hp-fallback" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Heures Pleines:</span>
            <span className="font-medium">{formatPrice(offer.hp_price)}</span>
          </div>
        )
      }
      if (offer.hc_price !== undefined && offer.hc_price !== null) {
        priceRows.push(
          <div key="hc-fallback" className="flex justify-between">
            <span className="text-gray-600 dark:text-gray-400">Heures Creuses:</span>
            <span className="font-medium">{formatPrice(offer.hc_price)}</span>
          </div>
        )
      }
    }

    return priceRows.length > 0 ? priceRows : <span className="text-gray-500">-</span>
  }

  const selectClassName = 'input text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'

  // État et refs pour les dropdowns custom
  const [openDropdown, setOpenDropdown] = useState<'provider' | 'type' | 'offer' | null>(null)
  const [providerSearch, setProviderSearch] = useState('')
  const providerSearchRef = useRef<HTMLInputElement>(null)
  const providerDropdownRef = useRef<HTMLDivElement>(null)
  const typeDropdownRef = useRef<HTMLDivElement>(null)
  const offerDropdownRef = useRef<HTMLDivElement>(null)

  // Fermer le dropdown quand on clique à l'extérieur
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const refs = { provider: providerDropdownRef, type: typeDropdownRef, offer: offerDropdownRef }
      if (openDropdown && refs[openDropdown]?.current && !refs[openDropdown].current!.contains(event.target as Node)) {
        setOpenDropdown(null)
        setProviderSearch('')
      }
    }
    if (openDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [openDropdown])

  // Nom formaté de l'offre sélectionnée (sans le suffixe kVA)
  const formatOfferName = (offer: EnergyOffer) =>
    offer.name.replace(/\s*-\s*\d+\s*kVA$/i, '')

  const formatExpiredLabel = (offer: EnergyOffer) => {
    if (offer.valid_to) {
      const date = new Date(offer.valid_to).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })
      return `jusqu'à ${date}`
    }
    return 'obsolète'
  }

  // Séparer les offres actives et obsolètes pour le dropdown
  const activeOffers = useMemo(() => availableOffers.filter(o => !isOfferExpired(o)), [availableOffers])
  const expiredOffers = useMemo(() => availableOffers.filter(o => isOfferExpired(o)), [availableOffers])

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Skeleton de chargement quand une offre est sélectionnée mais les données pas encore chargées */}
      {(isLoading || isOfferUnresolved) && selectedOfferId ? (
        <div className="grid grid-cols-3 gap-2">
          {[
            { icon: <Building2 size={12} />, label: 'Fournisseur' },
            { icon: <Zap size={12} />, label: 'Type' },
            { icon: <Tag size={12} />, label: 'Offre' },
          ].map(({ icon, label }) => (
            <div key={label}>
              <label className="flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                {icon}
                {label}
              </label>
              <div className="input text-sm flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-primary-400" />
                <span className="text-gray-400 dark:text-gray-500">Chargement...</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
      /* All selectors on one line */
      <div className="grid grid-cols-3 gap-2">
        {/* Provider Selector - Custom Dropdown */}
        <div className="relative" ref={providerDropdownRef}>
          <label className="flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            <Building2 size={12} />
            Fournisseur
          </label>
          <button
            type="button"
            onClick={() => {
              if (!disabled && !isLoading) {
                setOpenDropdown(openDropdown === 'provider' ? null : 'provider')
              }
            }}
            disabled={disabled || isLoading}
            className={`${selectClassName} w-full flex items-center justify-between gap-1 text-left`}
          >
            <span className={`truncate ${effectiveProviderId ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              {isLoading ? 'Chargement...' : (availableProviders.find(p => p.id === effectiveProviderId)?.name || 'Sélectionnez un fournisseur')}
            </span>
            <ChevronDown
              size={14}
              className={`flex-shrink-0 text-gray-400 transition-transform ${openDropdown === 'provider' ? 'rotate-180' : ''}`}
            />
          </button>

          {openDropdown === 'provider' && (
            <div className="absolute z-50 left-0 right-0 mt-1 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg shadow-lg">
              <div className="sticky top-0 bg-white dark:bg-gray-800 p-2 border-b border-gray-100 dark:border-gray-700">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    ref={providerSearchRef}
                    type="text"
                    value={providerSearch}
                    onChange={(e) => setProviderSearch(e.target.value)}
                    placeholder="Rechercher..."
                    className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    autoFocus
                  />
                </div>
              </div>
              <div className="max-h-52 overflow-y-auto">
                {availableProviders
                  .filter(p => !providerSearch || p.name.toLowerCase().includes(providerSearch.toLowerCase()))
                  .map(provider => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => {
                      handleProviderChange(provider.id)
                      setOpenDropdown(null)
                      setProviderSearch('')
                    }}
                    className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                      provider.id === effectiveProviderId ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                    }`}
                  >
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {provider.name}
                    </div>
                  </button>
                ))}
                {availableProviders.filter(p => !providerSearch || p.name.toLowerCase().includes(providerSearch.toLowerCase())).length === 0 && (
                  <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 text-center">
                    Aucun fournisseur trouvé
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Offer Type Selector - Custom Dropdown */}
        <div className="relative" ref={typeDropdownRef}>
          <label className="flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            <Zap size={12} />
            Type
          </label>
          <button
            type="button"
            onClick={() => {
              if (!disabled && !isLoading && effectiveProviderId) {
                setOpenDropdown(openDropdown === 'type' ? null : 'type')
              }
            }}
            disabled={disabled || isLoading || !effectiveProviderId}
            className={`${selectClassName} w-full flex items-center justify-between gap-1 text-left`}
          >
            <span className={`truncate ${effectiveOfferType ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              {isLoading ? 'Chargement...' : (effectiveOfferType ? (OFFER_TYPE_LABELS[effectiveOfferType] || effectiveOfferType) : '\u00A0')}
            </span>
            <ChevronDown
              size={14}
              className={`flex-shrink-0 text-gray-400 transition-transform ${openDropdown === 'type' ? 'rotate-180' : ''}`}
            />
          </button>

          {openDropdown === 'type' && (
            <div className="absolute z-50 left-0 right-0 mt-1 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg max-h-64 overflow-y-auto shadow-lg">
              {OFFER_TYPE_GROUPS.map(group => {
                const groupTypes = group.types.filter(t => availableOfferTypes.includes(t))
                if (groupTypes.length === 0) return null
                return (
                  <div key={group.label}>
                    <div className="px-4 py-1.5 bg-gray-100 dark:bg-gray-700/50 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide sticky top-0">
                      {group.label}
                    </div>
                    {groupTypes.map(type => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          handleOfferTypeChange(type)
                          setOpenDropdown(null)
                        }}
                        className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                          type === effectiveOfferType ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                        }`}
                      >
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {OFFER_TYPE_LABELS[type] || type}
                        </div>
                      </button>
                    ))}
                  </div>
                )
              })}
              {/* Types non classés (sécurité) */}
              {availableOfferTypes
                .filter(t => !OFFER_TYPE_GROUPS.some(g => g.types.includes(t)))
                .map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      handleOfferTypeChange(type)
                      setOpenDropdown(null)
                    }}
                    className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                      type === effectiveOfferType ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                    }`}
                  >
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {OFFER_TYPE_LABELS[type] || type}
                    </div>
                  </button>
                ))
              }
            </div>
          )}
        </div>

        {/* Offer Selector - Custom Dropdown */}
        <div className="relative" ref={offerDropdownRef}>
          <label className="flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            <Tag size={12} />
            Offre
          </label>
          <button
            type="button"
            onClick={() => {
              if (!disabled && !isLoading && effectiveProviderId && effectiveOfferType) {
                setOpenDropdown(openDropdown === 'offer' ? null : 'offer')
              }
            }}
            disabled={disabled || isLoading || !effectiveProviderId || !effectiveOfferType}
            className={`${selectClassName} w-full flex items-center justify-between gap-1 text-left`}
          >
            <span className={`truncate ${selectedOffer ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              {selectedOffer ? formatOfferName(selectedOffer) : '\u00A0'}
            </span>
            <ChevronDown
              size={14}
              className={`flex-shrink-0 text-gray-400 transition-transform ${openDropdown === 'offer' ? 'rotate-180' : ''}`}
            />
          </button>

          {openDropdown === 'offer' && (
            <div className="absolute z-50 left-0 right-0 mt-1 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg max-h-64 overflow-y-auto shadow-lg">
              {/* Offres actives */}
              {activeOffers.length > 0 && (
                <>
                  {activeOffers.map(offer => (
                    <button
                      key={offer.id}
                      type="button"
                      onClick={() => {
                        handleOfferChange(offer.id)
                        setOpenDropdown(null)
                      }}
                      className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                        offer.id === selectedOfferId ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                      }`}
                    >
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {formatOfferName(offer)}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {OFFER_TYPE_LABELS[offer.offer_type] || offer.offer_type}
                        {offer.power_kva && ` - ${offer.power_kva} kVA`}
                      </div>
                    </button>
                  ))}
                </>
              )}

              {/* Offres obsolètes */}
              {expiredOffers.length > 0 && (
                <>
                  <div className="px-4 py-2 bg-gray-100 dark:bg-gray-700/50 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide sticky top-0">
                    Offres obsolètes
                  </div>
                  {expiredOffers.map(offer => (
                    <button
                      key={offer.id}
                      type="button"
                      onClick={() => {
                        handleOfferChange(offer.id)
                        setOpenDropdown(null)
                      }}
                      className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                        offer.id === selectedOfferId ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                      }`}
                    >
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {formatOfferName(offer)}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {OFFER_TYPE_LABELS[offer.offer_type] || offer.offer_type}
                        {offer.power_kva && ` - ${offer.power_kva} kVA`}
                        {' · '}
                        <span className="text-amber-600 dark:text-amber-400">{formatExpiredLabel(offer)}</span>
                      </div>
                    </button>
                  ))}
                </>
              )}

              {/* Message si aucune offre */}
              {activeOffers.length === 0 && expiredOffers.length === 0 && (
                <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 text-center">
                  Aucune offre disponible
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {/* Selected offer summary */}
      {selectedOffer && (
        <div className={`p-3 rounded-lg border ${
          isSelectedOfferExpired
            ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700'
            : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
        }`}>
          {/* Avertissement offre périmée */}
          {isSelectedOfferExpired && (
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-amber-200 dark:border-amber-700">
              <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                Cette offre est obsolète
              </span>
            </div>
          )}
          {/* Header with provider and offer name */}
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`font-medium ${isSelectedOfferExpired ? 'text-amber-900 dark:text-amber-100' : 'text-blue-900 dark:text-blue-100'}`}>
                  {providers.find(p => p.id === selectedOffer.provider_id)?.name}
                </span>
                <span className={isSelectedOfferExpired ? 'text-amber-400' : 'text-blue-400'}>-</span>
                <span className={isSelectedOfferExpired ? 'text-amber-700 dark:text-amber-300' : 'text-blue-700 dark:text-blue-300'}>
                  {selectedOffer.name.replace(/\s*-\s*\d+\s*kVA$/i, '')}
                </span>
                <span className={`px-1.5 py-0.5 text-xs rounded ${
                  isSelectedOfferExpired
                    ? 'bg-amber-100 dark:bg-amber-800 text-amber-700 dark:text-amber-300'
                    : 'bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300'
                }`}>
                  {OFFER_TYPE_LABELS[selectedOffer.offer_type] || selectedOffer.offer_type}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClear}
              disabled={disabled}
              className="p-1.5 text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-800 rounded-lg transition-colors flex-shrink-0"
              title="Effacer la sélection"
            >
              <X size={16} />
            </button>
          </div>

          {/* Subscription price */}
          <div className="flex justify-between items-center mb-2 pb-2 border-b border-blue-200 dark:border-blue-700">
            <span className="text-sm text-gray-600 dark:text-gray-400">Abonnement:</span>
            <span className="font-semibold text-blue-700 dark:text-blue-300">
              {formatSubscription(selectedOffer.subscription_price)}
            </span>
          </div>

          {/* Power if specified */}
          {selectedOffer.power_kva && (
            <div className="flex justify-between items-center mb-2 pb-2 border-b border-blue-200 dark:border-blue-700">
              <span className="text-sm text-gray-600 dark:text-gray-400">Puissance:</span>
              <span className="font-medium text-blue-700 dark:text-blue-300">
                {selectedOffer.power_kva} kVA
              </span>
            </div>
          )}

          {/* Detailed prices */}
          <div className="space-y-1.5 text-sm text-blue-800 dark:text-blue-200">
            {getDetailedPrices(selectedOffer)}
          </div>

          {/* Price update date if available */}
          {selectedOffer.price_updated_at && (
            <div className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-700">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Tarifs mis à jour le {new Date(selectedOffer.price_updated_at).toLocaleDateString('fr-FR')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Help text when no offer selected */}
      {!selectedOffer && !isLoading && !selectedOfferId && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Sélectionnez un fournisseur, puis un type d'offre pour voir les offres disponibles
          {subscribedPower && ` pour ${subscribedPower} kVA`}.
        </p>
      )}
    </div>
  )
}
