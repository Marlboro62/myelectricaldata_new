import { useMemo } from 'react'
import { Receipt } from 'lucide-react'
import { sumTaxBreakdown } from '@/utils/electricityTaxes'
import type { YearlyCost } from '../types/euro.types'

interface EuroTaxBreakdownProps {
  year: YearlyCost
}

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)

const formatPercent = (value: number): string =>
  new Intl.NumberFormat('fr-FR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)

/**
 * Détail des taxes de la période : ce que contient le total TTC (énergie HT, accise, abonnement HT, TVA).
 * Les montants sont déduits des prix TTC de l'offre ; le total est identique à celui du tableau mensuel.
 */
export function EuroTaxBreakdown({ year }: EuroTaxBreakdownProps) {
  const t = useMemo(() => sumTaxBreakdown(year.months), [year.months])

  if (t.totalTTC <= 0) return null

  const avgAccise = t.kwh > 0 ? (t.accise / t.kwh) * 100 : 0 // c€/kWh
  const rows = [
    {
      label: 'Énergie HT',
      hint: 'Fourniture et acheminement (TURPE)',
      value: t.energyHT,
      dot: 'bg-green-500',
    },
    {
      label: 'Accise sur l\'électricité',
      hint: `${Math.round(t.kwh).toLocaleString('fr-FR')} kWh × ${avgAccise.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} c€ HT en moyenne`,
      value: t.accise,
      dot: 'bg-amber-500',
    },
    {
      label: 'Abonnement HT',
      hint: 'CTA comprise',
      value: t.subscriptionHT,
      dot: 'bg-blue-500',
    },
    {
      label: 'TVA',
      hint: `${formatCurrency(t.vatConsumption)} sur la consommation, ${formatCurrency(t.vatSubscription)} sur l'abonnement`,
      value: t.vat,
      dot: 'bg-purple-500',
    },
  ]
  const taxes = t.accise + t.vat

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <Receipt size={16} className="text-primary-600 dark:text-primary-400" />
          Taxes et contributions (estimation)
        </h4>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Accise + TVA : <span className="font-semibold text-gray-900 dark:text-gray-100">{formatCurrency(taxes)}</span>
          {' '}({formatPercent(taxes / t.totalTTC)} du total)
        </span>
      </div>

      {/* Barre de répartition du total TTC */}
      <div className="flex h-2 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700" aria-hidden="true">
        {rows.map((r) => (
          <div key={r.label} className={r.dot} style={{ width: `${Math.max(0, (r.value / t.totalTTC) * 100)}%` }} />
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-gray-100 dark:border-gray-800 first:border-t-0">
                <td className="py-2 px-2">
                  <div className="flex items-center gap-2 text-gray-900 dark:text-gray-100">
                    <span className={`inline-block w-2 h-2 rounded-full ${r.dot}`} />
                    {r.label}
                  </div>
                  <div className="pl-4 text-gray-500 dark:text-gray-400">{r.hint}</div>
                </td>
                <td className="py-2 px-2 text-right text-gray-600 dark:text-gray-400 whitespace-nowrap">
                  {formatPercent(r.value / t.totalTTC)}
                </td>
                <td className="py-2 px-2 text-right font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                  {formatCurrency(r.value)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-primary-50 dark:bg-primary-900/20 font-semibold">
              <td className="py-2 px-2 text-primary-900 dark:text-primary-100">Total TTC</td>
              <td />
              <td className="py-2 px-2 text-right text-primary-600 dark:text-primary-400 whitespace-nowrap">{formatCurrency(t.totalTTC)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Les prix des offres étant TTC, ces montants sont <strong>déjà inclus</strong> dans le total : ils ne s'y ajoutent pas.
        Accise au tarif légal en vigueur chaque mois (particuliers), TVA à 20 % (5,5 % sur l'abonnement avant le 1er août 2025).
        La CTA, calculée par le fournisseur sur la part acheminement de l'abonnement, reste comprise dans l'abonnement HT.
      </p>
    </div>
  )
}
