import { describe, it, expect } from 'vitest'
import type { EnergyOffer } from '@/api/energy'
import { isOfferExpired } from '../offers'

const NOW = new Date('2026-10-16T12:00:00Z')

const offer = (extra: Partial<EnergyOffer> = {}): EnergyOffer => ({
  id: 'o1',
  provider_id: 'p1',
  name: 'Offre',
  offer_type: 'BASE',
  subscription_price: 12,
  ...extra,
})

// MED-67 : une offre est close si elle est désactivée ou si sa période de validité est passée
describe('isOfferExpired', () => {
  it('offre active sans date de fin : en cours', () => {
    expect(isOfferExpired(offer({ is_active: true }), NOW)).toBe(false)
  })

  it('date de fin à venir : en cours', () => {
    expect(isOfferExpired(offer({ valid_to: '2026-12-31T00:00:00Z' }), NOW)).toBe(false)
  })

  it('date de fin passée : close', () => {
    expect(isOfferExpired(offer({ is_active: true, valid_to: '2026-08-01T00:00:00Z' }), NOW)).toBe(true)
  })

  it('offre désactivée : close, même sans date de fin', () => {
    expect(isOfferExpired(offer({ is_active: false }), NOW)).toBe(true)
  })
})
