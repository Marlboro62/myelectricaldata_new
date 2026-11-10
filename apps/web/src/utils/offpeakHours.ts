// Utility functions for off-peak hours calculations

export interface OffpeakRange {
  startHour: number
  startMin: number
  endHour: number
  endMin: number
}

/** Clé des heures creuses saisonnières dans offpeak_hours */
export const SEASONS_KEY = 'seasons'

export type OffpeakSeason = 'summer' | 'winter'

/** Plages saisies pour chaque saison (format « HH:MM-HH:MM ») et date de début (AAAA-MM-JJ) */
export interface OffpeakSeasonsConfig {
  since?: string | null
  summer?: string[]
  winter?: string[]
}

/** Plages saisonnières lues : vides pour une saison non saisie */
export interface OffpeakSeasons {
  since: string | null
  summer: OffpeakRange[]
  winter: OffpeakRange[]
}

/**
 * Saison des heures creuses saisonnalisées (CRE, réforme TURPE 7) :
 * été du 1er avril au 31 octobre, hiver du 1er novembre au 31 mars.
 */
export function seasonOf(date: Date): OffpeakSeason {
  const month = date.getMonth() + 1
  return month >= 4 && month <= 10 ? 'summer' : 'winter'
}

/** Date locale AAAA-MM-JJ (comparable à la date de début) */
function localDateKey(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Heures creuses saisonnières de offpeak_hours ({"ranges": [...], "seasons": {...}}),
 * null quand aucune plage saisonnière n'est saisie.
 */
export function parseOffpeakSeasons(offpeakConfig?: unknown): OffpeakSeasons | null {
  if (!offpeakConfig || typeof offpeakConfig !== 'object' || Array.isArray(offpeakConfig)) return null
  const raw = (offpeakConfig as Record<string, unknown>)[SEASONS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const config = raw as OffpeakSeasonsConfig
  const summer = parseOffpeakHours(Array.isArray(config.summer) ? config.summer : [])
  const winter = parseOffpeakHours(Array.isArray(config.winter) ? config.winter : [])
  if (summer.length === 0 && winter.length === 0) return null
  const since = typeof config.since === 'string' && /^\d{4}-\d{2}-\d{2}/.test(config.since) ? config.since.slice(0, 10) : null
  return { since, summer, winter }
}

/**
 * Plages HC à appliquer selon la date du relevé : plages de la saison à partir de la date de
 * début, sinon (avant cette date, ou saison non saisie) les plages habituelles.
 */
export function offpeakRangesResolver(offpeakConfig?: unknown): (date: Date) => OffpeakRange[] {
  const base = parseOffpeakHours(offpeakConfig as Parameters<typeof parseOffpeakHours>[0])
  const seasons = parseOffpeakSeasons(offpeakConfig)
  if (!seasons) return () => base
  return (date: Date) => {
    if (seasons.since && localDateKey(date) < seasons.since) return base
    const ranges = seasonOf(date) === 'summer' ? seasons.summer : seasons.winter
    return ranges.length > 0 ? ranges : base
  }
}

/**
 * Parse offpeak hours configuration from PDL
 * Supports both array format ["22:00-06:00"] and legacy object format {"HC": "22h00-06h00"}
 */
export function parseOffpeakHours(offpeakConfig?: string[] | Record<string, string> | Record<string, any>): OffpeakRange[] {
  if (!offpeakConfig) return []

  const ranges: OffpeakRange[] = []

  // Handle array format and object format
  // Also handle nested arrays like {"ranges": ["22:00-06:00"]}
  let rawValues: unknown[]
  if (Array.isArray(offpeakConfig)) {
    rawValues = offpeakConfig
  } else {
    // « seasons » porte les heures creuses saisonnières (cf. parseOffpeakSeasons), pas les plages habituelles
    rawValues = Object.entries(offpeakConfig)
      .filter(([key]) => key !== SEASONS_KEY)
      .flatMap(([, v]) => Array.isArray(v) ? v : [v])
  }
  const rangeStrings: string[] = rawValues.filter((item): item is string => typeof item === 'string' && Boolean(item))

  for (const range of rangeStrings) {
    // Skip if range is not a string (safety check)
    if (typeof range !== 'string') continue

    // Extract time ranges from various formats: "22h30-06h30", "22:00-06:00", "HC (22H00-6H00)", etc.
    // Match: optional text, then first time (HH:MM or HHhMM), separator, then second time
    const match = range.match(/(\d{1,2})[hH:](\d{0,2})\s*-\s*(\d{1,2})[hH:]?(\d{0,2})/)
    if (match) {
      const startHour = parseInt(match[1])
      const startMin = match[2] ? parseInt(match[2]) : 0
      const endHour = parseInt(match[3])
      const endMin = match[4] ? parseInt(match[4]) : 0

      ranges.push({ startHour, startMin, endHour, endMin })
    }
  }

  return ranges
}

/**
 * Check if a given time (hour:minute) falls within off-peak hours
 */
export function isOffpeakTime(hour: number, minute: number, ranges: OffpeakRange[]): boolean {
  if (ranges.length === 0) {
    // Default: 22h-6h if no config
    return hour >= 22 || hour < 6
  }

  const timeInMinutes = hour * 60 + minute

  for (const range of ranges) {
    const startInMinutes = range.startHour * 60 + range.startMin
    const endInMinutes = range.endHour * 60 + range.endMin

    // Handle ranges that cross midnight (e.g., 22:30-06:30)
    if (startInMinutes > endInMinutes) {
      // Range crosses midnight
      if (timeInMinutes >= startInMinutes || timeInMinutes < endInMinutes) {
        return true
      }
    } else {
      // Normal range within same day
      if (timeInMinutes >= startInMinutes && timeInMinutes < endInMinutes) {
        return true
      }
    }
  }

  return false
}

/**
 * Part du créneau [hour:minute, +durationMinutes[ passée en heures creuses, entre 0 et 1.
 *
 * Une plage HC peut commencer ou finir au milieu d'un créneau de la courbe de charge (contrat en
 * 23h32-5h32 par exemple) : classer tout le créneau d'après son heure de début décale la répartition
 * HC / HP par rapport au compteur. Le créneau est donc réparti au prorata de ses minutes, comme dans
 * les exports (backend). Une plage calée sur le pas donne 0 ou 1, comme isOffpeakTime.
 */
export function offpeakFraction(hour: number, minute: number, durationMinutes: number, ranges: OffpeakRange[]): number {
  const duration = Math.max(1, Math.round(durationMinutes))
  const start = hour * 60 + minute
  let offpeakMinutes = 0
  for (let i = 0; i < duration; i++) {
    const t = (start + i) % 1440
    if (isOffpeakTime(Math.floor(t / 60), t % 60, ranges)) offpeakMinutes++
  }
  return offpeakMinutes / duration
}

/**
 * Check if a given hour is in off-peak (simplified version for hour-only checks)
 */
export function isOffpeakHour(hour: number, offpeakConfig?: string[] | Record<string, string> | Record<string, any>): boolean {
  const ranges = parseOffpeakHours(offpeakConfig)
  return isOffpeakTime(hour, 0, ranges)
}
