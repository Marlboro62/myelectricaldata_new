import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarRange, Minus, Plus, Save, Snowflake, Sun } from 'lucide-react'
import { pdlApi } from '@/api/pdl'
import { toast } from '@/stores/notificationStore'
import { SEASONS_KEY, parseOffpeakHours, type OffpeakSeason, type OffpeakSeasonsConfig } from '@/utils/offpeakHours'

/**
 * Heures creuses saisonnières (réforme TURPE 7) : plages d'été (1er avril → 31 octobre) et
 * d'hiver (1er novembre → 31 mars), à partir d'une date. Enregistrées dans la clé « seasons »
 * de offpeak_hours, à côté des plages habituelles qui restent utilisées avant cette date.
 */

interface Range {
  start: string
  end: string
}

interface SeasonalOffpeakEditorProps {
  pdlId: string
  offpeakHours: unknown
  disabled?: boolean
}

const SEASONS: Array<{ key: OffpeakSeason; label: string; period: string; Icon: typeof Sun }> = [
  { key: 'winter', label: 'Hiver', period: '1er novembre → 31 mars', Icon: Snowflake },
  { key: 'summer', label: 'Été', period: '1er avril → 31 octobre', Icon: Sun },
]

const pad = (n: number) => n.toString().padStart(2, '0')

/** « 22:00-06:00 », « 22h00-6h00 » → { start: '22:00', end: '06:00' } */
function toRange(text: unknown): Range | null {
  if (typeof text !== 'string') return null
  const m = text.match(/(\d{1,2})\s*[hH:]\s*(\d{2})?\s*-\s*(\d{1,2})\s*[hH:]\s*(\d{2})?/)
  if (!m) return null
  return { start: `${pad(+m[1])}:${m[2] || '00'}`, end: `${pad(+m[3])}:${m[4] || '00'}` }
}

const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** Durée HC d'une liste de plages, en heures (une plage qui passe minuit compte jusqu'au lendemain) */
function totalHours(ranges: Range[]): number {
  return ranges.reduce((sum, r) => sum + ((toMinutes(r.end) - toMinutes(r.start) + 1440) % 1440) / 60, 0)
}

/** Plages habituelles du PDL, point de départ des plages saisonnières (22h-6h à défaut) */
function baseRanges(offpeakHours: unknown): Range[] {
  const parsed = parseOffpeakHours(offpeakHours as Parameters<typeof parseOffpeakHours>[0]).map((r) => ({
    start: `${pad(r.startHour)}:${pad(r.startMin)}`,
    end: `${pad(r.endHour % 24)}:${pad(r.endMin)}`,
  }))
  return parsed.length > 0 ? parsed : [{ start: '22:00', end: '06:00' }]
}

function readSeasons(offpeakHours: unknown): { since: string; winter: Range[]; summer: Range[] } | null {
  if (!offpeakHours || typeof offpeakHours !== 'object' || Array.isArray(offpeakHours)) return null
  const raw = (offpeakHours as Record<string, unknown>)[SEASONS_KEY] as OffpeakSeasonsConfig | undefined
  if (!raw || typeof raw !== 'object') return null
  const list = (v: unknown) => (Array.isArray(v) ? v.map(toRange).filter((r): r is Range => r !== null) : [])
  const winter = list(raw.winter)
  const summer = list(raw.summer)
  if (winter.length === 0 && summer.length === 0) return null
  return { since: typeof raw.since === 'string' ? raw.since.slice(0, 10) : '', winter, summer }
}

/** Frise 0h-24h des plages d'une saison */
function Timeline({ ranges }: { ranges: Range[] }) {
  const blocks = ranges.flatMap((r) => {
    const s = toMinutes(r.start) / 14.4
    const e = r.end === '00:00' ? 100 : toMinutes(r.end) / 14.4
    return e > s ? [[s, e]] : e < s ? [[s, 100], [0, e]] : []
  })
  return (
    <div className="relative h-4 bg-red-100 dark:bg-red-800/40 rounded border border-gray-300 dark:border-gray-600 overflow-hidden">
      {blocks.map(([s, e], i) => (
        <div key={i} className="absolute inset-y-0 bg-emerald-500/70" style={{ left: `${s}%`, width: `${e - s}%` }} />
      ))}
    </div>
  )
}

export default function SeasonalOffpeakEditor({ pdlId, offpeakHours, disabled = false }: SeasonalOffpeakEditorProps) {
  const queryClient = useQueryClient()
  // Clé stable : un rechargement du PDL aux mêmes valeurs ne réinitialise pas la saisie en cours
  const savedKey = JSON.stringify(offpeakHours ?? null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saved = useMemo(() => readSeasons(offpeakHours), [savedKey])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => baseRanges(offpeakHours), [savedKey])
  const [enabled, setEnabled] = useState(saved !== null)
  const [since, setSince] = useState(saved?.since || '')
  const [ranges, setRanges] = useState<Record<OffpeakSeason, Range[]>>({
    winter: saved?.winter.length ? saved.winter : base,
    summer: saved?.summer.length ? saved.summer : base,
  })

  // Nouvelles valeurs du PDL (enregistrement, synchronisation)
  useEffect(() => {
    setEnabled(saved !== null)
    setSince(saved?.since || '')
    setRanges({
      winter: saved?.winter.length ? saved.winter : base,
      summer: saved?.summer.length ? saved.summer : base,
    })
  }, [saved, base])

  const mutation = useMutation({
    mutationFn: (seasons: OffpeakSeasonsConfig | null) => {
      // Plages habituelles conservées telles quelles ; « seasons »: null retire les saisons
      const current = Array.isArray(offpeakHours)
        ? { ranges: offpeakHours }
        : Object.fromEntries(Object.entries((offpeakHours as Record<string, unknown>) || {}).filter(([k]) => k !== SEASONS_KEY))
      return pdlApi.updateContract(pdlId, { offpeak_hours: { ...current, [SEASONS_KEY]: seasons } })
    },
    onSuccess: (_data, seasons) => {
      queryClient.invalidateQueries({ queryKey: ['pdls'] })
      queryClient.invalidateQueries({ queryKey: ['pdl'] })
      toast.success(seasons ? 'Heures creuses saisonnières enregistrées' : 'Heures creuses saisonnières désactivées')
    },
    onError: () => toast.error("Les heures creuses saisonnières n'ont pas pu être enregistrées"),
  })

  const update = (season: OffpeakSeason, index: number, field: keyof Range, value: string) =>
    setRanges((prev) => ({ ...prev, [season]: prev[season].map((r, i) => (i === index ? { ...r, [field]: value } : r)) }))
  const add = (season: OffpeakSeason) =>
    setRanges((prev) => ({ ...prev, [season]: [...prev[season], { start: '12:00', end: '14:00' }] }))
  const remove = (season: OffpeakSeason, index: number) =>
    setRanges((prev) => ({ ...prev, [season]: prev[season].filter((_, i) => i !== index) }))

  const save = () => {
    const clean = (list: Range[]) => list.filter((r) => r.start && r.end && r.start !== r.end).map((r) => `${r.start}-${r.end}`)
    const seasons = { since: since || null, winter: clean(ranges.winter), summer: clean(ranges.summer) }
    if (seasons.winter.length === 0 && seasons.summer.length === 0) {
      toast.warning('Ajoutez au moins une plage pour une saison')
      return
    }
    mutation.mutate(seasons)
  }

  const toggle = (checked: boolean) => {
    setEnabled(checked)
    if (!checked && saved) mutation.mutate(null)
  }

  return (
    <div className="space-y-3 pt-3 border-t border-gray-200 dark:border-gray-700" data-tour="pdl-offpeak-seasons">
      <label className="flex items-center gap-2 cursor-pointer">
        <CalendarRange size={16} className="text-gray-600 dark:text-gray-400" />
        <span className="flex-1 text-gray-600 dark:text-gray-400">Heures creuses saisonnières</span>
        <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">bêta</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled || mutation.isPending}
          onChange={(e) => toggle(e.target.checked)}
          className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 cursor-pointer"
        />
      </label>

      {enabled && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Avec la réforme des heures creuses, les plages peuvent changer entre l'hiver et l'été. Saisissez celles
            indiquées par votre fournisseur. Avant la date de début, et pour une saison sans plage, les heures creuses
            habituelles ci-dessus s'appliquent.
          </p>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-600 dark:text-gray-400">À partir du</span>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              disabled={disabled}
              className="px-2 py-1 bg-white dark:bg-gray-800 border border-blue-300 dark:border-blue-700 rounded text-sm text-gray-900 dark:text-gray-100"
            />
            {!since && <span className="text-xs text-gray-500 dark:text-gray-400">(vide : tout l'historique)</span>}
          </div>

          {SEASONS.map(({ key, label, period, Icon }) => (
            <div key={key} className="space-y-2 p-2.5 bg-blue-50/30 dark:bg-blue-900/5 border border-blue-200 dark:border-blue-800/20 rounded-lg">
              <div className="flex items-center gap-2 text-sm">
                <Icon size={16} className={key === 'summer' ? 'text-amber-500' : 'text-sky-500'} />
                <span className="font-semibold text-gray-900 dark:text-gray-100">{label}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{period}</span>
                <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">{totalHours(ranges[key]).toLocaleString('fr-FR')} h</span>
                <button
                  type="button"
                  onClick={() => add(key)}
                  disabled={disabled}
                  className="p-1 text-white bg-blue-600 hover:bg-blue-700 rounded transition-all"
                  title="Ajouter une plage"
                >
                  <Plus size={14} />
                </button>
              </div>
              <Timeline ranges={ranges[key]} />
              {ranges[key].map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="time"
                    step={60}
                    value={r.start}
                    onChange={(e) => update(key, i, 'start', e.target.value)}
                    disabled={disabled}
                    className="flex-1 min-w-0 px-2 py-1 bg-white dark:bg-gray-800 border border-blue-300 dark:border-blue-700 rounded text-sm font-semibold text-center text-gray-900 dark:text-gray-100"
                  />
                  <span className="text-blue-600 dark:text-blue-400 font-bold">→</span>
                  <input
                    type="time"
                    step={60}
                    value={r.end}
                    onChange={(e) => update(key, i, 'end', e.target.value)}
                    disabled={disabled}
                    className="flex-1 min-w-0 px-2 py-1 bg-white dark:bg-gray-800 border border-blue-300 dark:border-blue-700 rounded text-sm font-semibold text-center text-gray-900 dark:text-gray-100"
                  />
                  <button
                    type="button"
                    onClick={() => remove(key, i)}
                    disabled={disabled}
                    className="p-1.5 text-white bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 rounded transition-all"
                    title="Supprimer cette plage"
                  >
                    <Minus size={14} />
                  </button>
                </div>
              ))}
              {ranges[key].length === 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400">Aucune plage : heures creuses habituelles</p>
              )}
            </div>
          ))}

          <button
            type="button"
            onClick={save}
            disabled={disabled || mutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm disabled:opacity-50 transition-all"
          >
            <Save size={16} />
            <span>{mutation.isPending ? 'Enregistrement…' : 'Enregistrer'}</span>
          </button>
        </div>
      )}
    </div>
  )
}
