/**
 * Closed offer: deactivated, or its validity period is over.
 * Same rule as the GET /energy/offers filter without include_history.
 * valid_to may be null: the API sends null for an open-ended offer.
 */
export function isOfferExpired(offer: { is_active?: boolean; valid_to?: string | null }, now: Date = new Date()): boolean {
  if (offer.is_active === false) return true
  if (offer.valid_to && new Date(offer.valid_to) < now) return true
  return false
}
