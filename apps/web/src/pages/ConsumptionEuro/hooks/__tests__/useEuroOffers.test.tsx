import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EnergyOffer, EnergyProvider } from '@/api/energy'
import { energyApi } from '@/api/energy'
import { useEuroOffers } from '../useEuroOffers'

vi.mock('@/api/energy', () => ({
  energyApi: {
    getProviders: vi.fn(),
    getOffers: vi.fn(),
  },
}))

const PROVIDERS: EnergyProvider[] = [
  { id: 'ecodigo', name: 'Ecodigo' },
  { id: 'edf', name: 'EDF' },
]

const offer = (id: string, extra: Partial<EnergyOffer>): EnergyOffer => ({
  id,
  provider_id: 'ecodigo',
  name: id,
  offer_type: 'BASE',
  subscription_price: 12,
  power_kva: 6,
  is_active: true,
  ...extra,
})

// Grille Ecodigo close le 01/08/2026 (cas des 7 PDL Ecodigo en prod), remplacée par une grille en cours
const CLOSED_PDL_OFFER = offer('ecodigo-2025', { valid_to: '2026-08-01T00:00:00Z' })
const CURRENT_OFFER = offer('ecodigo-2026', { valid_from: '2026-08-01T00:00:00Z' })
const OTHER_CLOSED = offer('edf-ejp', { provider_id: 'edf', offer_type: 'EJP', is_active: false })
const OTHER_POWER = offer('edf-9kva', { provider_id: 'edf', power_kva: 9 })
const ALL_OFFERS = [CLOSED_PDL_OFFER, CURRENT_OFFER, OTHER_CLOSED, OTHER_POWER]

// Filtre de GET /energy/offers sans include_history (energy_offers.py, list_offers)
const isCurrentForApi = (o: EnergyOffer) =>
  o.is_active === true && (!o.valid_to || new Date(o.valid_to) >= new Date())

function renderOffers(props: Parameters<typeof useEuroOffers>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(() => useEuroOffers(props), { wrapper })
}

// MED-67 : la page Consommation € doit retrouver l'offre du PDL même close
describe('useEuroOffers : offre du PDL close', () => {
  beforeEach(() => {
    vi.mocked(energyApi.getProviders).mockResolvedValue({ success: true, data: PROVIDERS, timestamp: '2026-10-16T12:00:00Z' })
    // Même filtre que GET /energy/offers : sans include_history, seules les offres en cours reviennent
    vi.mocked(energyApi.getOffers).mockImplementation(async (_providerId?: string, includeHistory?: boolean) => ({
      success: true,
      data: includeHistory ? ALL_OFFERS : ALL_OFFERS.filter(isCurrentForApi),
      timestamp: '2026-10-16T12:00:00Z',
    }))
  })

  it("retrouve l'offre close du PDL avec le nom de son fournisseur", async () => {
    const { result } = renderOffers({ selectedOfferId: CLOSED_PDL_OFFER.id, comparisonOfferId: null })

    await waitFor(() => expect(result.current.selectedOfferWithProvider).not.toBeNull())
    expect(result.current.selectedOfferWithProvider?.id).toBe(CLOSED_PDL_OFFER.id)
    expect(result.current.selectedOfferWithProvider?.providerName).toBe('Ecodigo')
  })

  it("signale l'offre close et sa date de fin", async () => {
    const { result } = renderOffers({ selectedOfferId: CLOSED_PDL_OFFER.id, comparisonOfferId: null })

    await waitFor(() => expect(result.current.selectedOfferWithProvider).not.toBeNull())
    expect(result.current.isSelectedOfferClosed).toBe(true)
    expect(result.current.selectedOfferWithProvider?.valid_to).toBe(CLOSED_PDL_OFFER.valid_to)
  })

  it("comparateur : offres en cours de même puissance, plus l'offre actuelle du PDL", async () => {
    const { result } = renderOffers({ selectedOfferId: CLOSED_PDL_OFFER.id, comparisonOfferId: null })

    await waitFor(() => expect(result.current.selectedOfferWithProvider).not.toBeNull())
    const ids = result.current.compatibleOffers.map((o) => o.id).sort()
    expect(ids).toEqual([CLOSED_PDL_OFFER.id, CURRENT_OFFER.id].sort())
  })

  it("offre en cours : pas signalée close, comparateur sans les grilles closes", async () => {
    const { result } = renderOffers({ selectedOfferId: CURRENT_OFFER.id, comparisonOfferId: null })

    await waitFor(() => expect(result.current.selectedOfferWithProvider).not.toBeNull())
    expect(result.current.isSelectedOfferClosed).toBe(false)
    expect(result.current.compatibleOffers.map((o) => o.id)).toEqual([CURRENT_OFFER.id])
  })

  it("garde l'offre de comparaison choisie", async () => {
    const { result } = renderOffers({ selectedOfferId: CLOSED_PDL_OFFER.id, comparisonOfferId: CURRENT_OFFER.id })

    await waitFor(() => expect(result.current.comparisonOfferWithProvider).not.toBeNull())
    expect(result.current.comparisonOfferWithProvider?.id).toBe(CURRENT_OFFER.id)
  })
})
