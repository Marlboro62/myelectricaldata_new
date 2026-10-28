/**
 * Détail des taxes d'une facture d'électricité, déduit des montants TTC.
 *
 * Les prix des offres sont saisis TTC : la page Consommation (€) calcule donc déjà le bon total.
 * Ce module retrouve, mois par mois, ce que ce total contient :
 * - l'accise sur l'électricité (ex-TICFE / CSPE) : kWh consommés × tarif légal en vigueur ;
 * - la TVA : 20 % sur la consommation, et sur l'abonnement 5,5 % avant le 1er août 2025 puis 20 % ;
 * - le reste : énergie HT (fourniture et acheminement) et abonnement HT.
 *
 * Les taux sont ceux de la date du prix de l'offre (`offerPriceMonth`) quand elle est connue, sinon ceux du mois.
 *
 * La CTA (contribution tarifaire d'acheminement) est calculée par le fournisseur sur la part fixe
 * du TURPE, qui ne figure pas dans les données des offres : elle reste comprise dans l'abonnement HT.
 *
 * Champ d'application : France métropolitaine continentale, catégorie « ménages et assimilés »
 * (particuliers, puissance souscrite jusqu'à 36 kVA).
 */

/** Tarif de l'accise sur l'électricité, catégorie ménages, en €/kWh HT, par date d'effet (AAAA-MM). */
export const ACCISE_RATES: ReadonlyArray<{ from: string; rate: number }> = [
  { from: '2016-01', rate: 0.0225 }, // CSPE 22,50 €/MWh
  { from: '2022-02', rate: 0.001 }, // bouclier tarifaire : 1 €/MWh
  { from: '2024-02', rate: 0.021 }, // fin du bouclier : 21 €/MWh
  { from: '2025-02', rate: 0.0337 }, // 33,70 €/MWh
  { from: '2025-08', rate: 0.02998 }, // 29,98 €/MWh (compense la TVA à 20 % sur l'abonnement)
  { from: '2026-02', rate: 0.03085 }, // 30,85 €/MWh
  { from: '2026-08', rate: 0.03062 }, // 30,62 €/MWh
]

/** TVA sur la consommation (et sur l'accise). */
export const VAT_CONSUMPTION = 0.2

/** Depuis ce mois (AAAA-MM), l'abonnement est soumis à 20 % au lieu de 5,5 %. */
export const VAT_SUBSCRIPTION_FULL_FROM = '2025-08'

/** Tarif d'accise (€/kWh HT) applicable au mois donné (AAAA-MM), 0 avant le premier tarif connu. */
export function acciseRate(month: string): number {
  let rate = 0
  for (const r of ACCISE_RATES) {
    if (month >= r.from) rate = r.rate
  }
  return rate
}

/** Taux de TVA de l'abonnement pour le mois donné (AAAA-MM). */
export function subscriptionVatRate(month: string): number {
  return month >= VAT_SUBSCRIPTION_FULL_FROM ? 0.2 : 0.055
}

export interface TaxInput {
  month: string // AAAA-MM
  totalKwh: number
  consumptionCost: number // TTC
  subscriptionCost: number // TTC
}

export interface TaxBreakdown {
  /** Énergie HT hors accise : fourniture et acheminement */
  energyHT: number
  /** Accise sur l'électricité (HT) */
  accise: number
  /** Abonnement HT (CTA comprise) */
  subscriptionHT: number
  /** TVA sur la consommation et l'accise */
  vatConsumption: number
  /** TVA sur l'abonnement */
  vatSubscription: number
  /** TVA totale */
  vat: number
  /** Total TTC (égal à consommation + abonnement) */
  totalTTC: number
  /** kWh pris en compte pour l'accise */
  kwh: number
}

const EMPTY: TaxBreakdown = {
  energyHT: 0, accise: 0, subscriptionHT: 0, vatConsumption: 0, vatSubscription: 0, vat: 0, totalTTC: 0, kwh: 0,
}

/**
 * Mois (AAAA-MM) des prix de l'offre : date de mise en service, à défaut date de mise à jour des tarifs.
 *
 * La page applique ce prix TTC à tous les mois, même anciens : il contient l'accise et la TVA d'abonnement
 * en vigueur à cette date, et c'est elles qu'il faut retirer pour retrouver les parts du total.
 */
export function offerPriceMonth(offer?: { valid_from?: string; price_updated_at?: string } | null): string | undefined {
  const date = offer?.valid_from || offer?.price_updated_at
  return date ? date.slice(0, 7) : undefined
}

/**
 * Détail des taxes d'un mois, à partir des montants TTC calculés par la page.
 * `rateMonth` fixe le mois des taux (celui du prix de l'offre) ; par défaut, le mois consommé.
 */
export function monthTaxBreakdown(
  { month, totalKwh, consumptionCost, subscriptionCost }: TaxInput,
  rateMonth: string = month,
): TaxBreakdown {
  const consumptionHT = consumptionCost / (1 + VAT_CONSUMPTION)
  const accise = totalKwh * acciseRate(rateMonth)
  const subscriptionHT = subscriptionCost / (1 + subscriptionVatRate(rateMonth))
  const vatConsumption = consumptionCost - consumptionHT
  const vatSubscription = subscriptionCost - subscriptionHT
  return {
    energyHT: consumptionHT - accise,
    accise,
    subscriptionHT,
    vatConsumption,
    vatSubscription,
    vat: vatConsumption + vatSubscription,
    totalTTC: consumptionCost + subscriptionCost,
    kwh: totalKwh,
  }
}

/** Somme du détail des taxes sur plusieurs mois, aux taux de `rateMonth` s'il est donné. */
export function sumTaxBreakdown(months: TaxInput[], rateMonth?: string): TaxBreakdown {
  return months.map((m) => monthTaxBreakdown(m, rateMonth)).reduce(
    (acc, m) => ({
      energyHT: acc.energyHT + m.energyHT,
      accise: acc.accise + m.accise,
      subscriptionHT: acc.subscriptionHT + m.subscriptionHT,
      vatConsumption: acc.vatConsumption + m.vatConsumption,
      vatSubscription: acc.vatSubscription + m.vatSubscription,
      vat: acc.vat + m.vat,
      totalTTC: acc.totalTTC + m.totalTTC,
      kwh: acc.kwh + m.kwh,
    }),
    { ...EMPTY },
  )
}
