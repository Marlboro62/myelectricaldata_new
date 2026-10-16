import { Info } from 'lucide-react'
import { useAppMode } from '@/hooks/useAppMode'

interface InfoBlockProps {
  isExpanded: boolean
  onToggle: () => void
}

export function InfoBlock({ isExpanded, onToggle }: InfoBlockProps) {
  const { isClientMode } = useAppMode()
  return (
    <div className="mt-6 rounded-xl shadow-md border bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 transition-colors duration-200">
      {/* Collapsible Header */}
      <div
        className="flex items-center justify-between p-6 cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2">
          <Info className="text-primary-600 dark:text-primary-400" size={20} />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Informations importantes
          </h3>
        </div>
        <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
          {isExpanded ? (
            <span className="text-sm">Réduire</span>
          ) : (
            <span className="text-sm">Développer</span>
          )}
          <svg
            className={`w-5 h-5 transition-transform duration-200 ${
              isExpanded ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Collapsible Content */}
      {isExpanded && (
        <div className="px-6 pb-6 space-y-4">
          {/* Cache Information */}
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              <strong>💾 Cache automatique :</strong> L'utilisation de la page de consommation active automatiquement le cache. Vos données de consommation seront stockées temporairement pour améliorer les performances et éviter de solliciter excessivement l'API Enedis. Les données en cache expirent automatiquement après <strong>24 heures</strong>.
            </p>
          </div>

          {/* Data Source Information */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="text-sm text-blue-800 dark:text-blue-200 space-y-2">
              <p>
                <strong>📊 Source des données :</strong>
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Les données sont récupérées depuis l'API <strong>Enedis Data Connect</strong></li>
                <li>Enedis fournit <strong>1095 jours</strong> de données quotidiennes (3 ans)</li>
                <li>Enedis fournit <strong>730 jours</strong> de données détaillées (30 min, 2 ans)</li>
                {isClientMode && <li>Mode client : tout l'historique déjà stocké en base locale (import V1 compris) est affiché, au-delà de ces limites</li>}
                <li>Les données Enedis ne sont disponibles qu'en <strong>J-1</strong> (hier)</li>
                <li>Les calculs HC/HP utilisent des <strong>périodes glissantes d'un an</strong>, non des années calendaires</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
