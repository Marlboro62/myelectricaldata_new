import type { EnergyOffer } from '@/api/energy'

/**
 * Offre close : désactivée, ou dont la période de validité est passée.
 * Même règle que le filtre de GET /energy/offers sans include_history.
 */
export function isOfferExpired(offer: Pick<EnergyOffer, 'is_active' | 'valid_to'>, now: Date = new Date()): boolean {
  if (offer.is_active === false) return true
  if (offer.valid_to && new Date(offer.valid_to) < now) return true
  return false
}
