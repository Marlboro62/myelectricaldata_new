import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OfferPricingCard } from '../OfferPricingCard'
import type { SelectedOfferWithProvider } from '../../types/euro.types'

const CLOSED_OFFER: SelectedOfferWithProvider = {
  id: 'ecodigo-2025',
  provider_id: 'ecodigo',
  providerName: 'Ecodigo',
  name: 'Ecodigo 2025',
  offer_type: 'BASE',
  subscription_price: 12,
  base_price: 0.2,
  power_kva: 6,
  is_active: true,
  valid_to: '2026-08-01T00:00:00Z',
}

const renderCard = (props: Partial<Parameters<typeof OfferPricingCard>[0]> = {}) =>
  render(
    <MemoryRouter>
      <OfferPricingCard selectedOffer={CLOSED_OFFER} {...props} />
    </MemoryRouter>,
  )

// MED-67 : badge de l'offre close du PDL, avec un lien pour en changer
describe('OfferPricingCard : offre close', () => {
  it('affiche la date de fin (jour UTC) et un lien vers le tableau de bord', () => {
    renderCard({ isOfferClosed: true })

    expect(screen.getByText(/Offre close depuis le 01\/08\/2026/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: "changer d'offre" })).toHaveAttribute('href', '/dashboard')
  })

  it('offre close sans date de fin : libellé court', () => {
    renderCard({ isOfferClosed: true, selectedOffer: { ...CLOSED_OFFER, is_active: false, valid_to: undefined } })

    expect(screen.getByText(/^Offre close/)).toBeInTheDocument()
    expect(screen.queryByText(/depuis le/)).not.toBeInTheDocument()
  })

  it('le clic sur le lien ne déplie pas la carte', () => {
    renderCard({ isOfferClosed: true })

    fireEvent.click(screen.getByRole('link', { name: "changer d'offre" }))
    expect(screen.getByText('Détails')).toBeInTheDocument()
  })

  it('offre en cours : pas de badge', () => {
    renderCard()

    expect(screen.queryByText(/Offre close/)).not.toBeInTheDocument()
  })
})
