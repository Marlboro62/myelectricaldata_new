import { describe, expect, it } from 'vitest'
import { isOffpeakTime, offpeakFraction, offpeakRangesResolver, parseOffpeakHours, parseOffpeakSeasons, seasonOf } from '../offpeakHours'

// Contrat dont les plages HC ne tombent pas sur la demi-heure (cas réel comparé au ZLinky)
const DECALEES = parseOffpeakHours({ ranges: ['23:32-05:32', '14:32-16:32'] })
const CALEES = parseOffpeakHours({ ranges: ['22:00-06:00'] })

describe('offpeakFraction', () => {
  it('répartit au prorata un créneau où commence une plage HC', () => {
    // 23h30-0h00 : 28 minutes en HC sur 30
    expect(offpeakFraction(23, 30, 30, DECALEES)).toBeCloseTo(28 / 30)
  })

  it('répartit au prorata un créneau où finit une plage HC', () => {
    // 5h30-6h00 : 2 minutes en HC sur 30
    expect(offpeakFraction(5, 30, 30, DECALEES)).toBeCloseTo(2 / 30)
    // 16h30-17h00 : 2 minutes en HC
    expect(offpeakFraction(16, 30, 30, DECALEES)).toBeCloseTo(2 / 30)
  })

  it('donne 0 ou 1 pour un créneau entièrement HP ou HC', () => {
    expect(offpeakFraction(2, 0, 30, DECALEES)).toBe(1)
    expect(offpeakFraction(10, 0, 30, DECALEES)).toBe(0)
  })

  it('donne le même résultat que isOffpeakTime pour des plages calées sur la demi-heure', () => {
    for (let t = 0; t < 1440; t += 30) {
      const hour = Math.floor(t / 60)
      const minute = t % 60
      expect(offpeakFraction(hour, minute, 30, CALEES)).toBe(isOffpeakTime(hour, minute, CALEES) ? 1 : 0)
    }
  })

  it('suit le pas du relevé (15 minutes) et passe minuit', () => {
    expect(offpeakFraction(23, 30, 15, DECALEES)).toBeCloseTo(13 / 15)
    expect(offpeakFraction(23, 45, 30, CALEES)).toBe(1)
  })

  it('retrouve la journée du compteur : 6 h de HC sur 24 h', () => {
    let hc = 0
    for (let t = 0; t < 1440; t += 30) hc += offpeakFraction(Math.floor(t / 60), t % 60, 30, DECALEES) * 30
    expect(hc).toBe(8 * 60)
  })
})

describe('heures creuses saisonnières', () => {
  const config = {
    ranges: ['22:00-06:00'],
    seasons: { since: '2026-11-01', winter: ['00:00-06:00', '22:00-24:00'], summer: ['02:00-06:00', '11:00-15:00'] },
  }

  it('saison : été du 1er avril au 31 octobre', () => {
    expect(seasonOf(new Date(2027, 2, 31))).toBe('winter')
    expect(seasonOf(new Date(2027, 3, 1))).toBe('summer')
    expect(seasonOf(new Date(2027, 9, 31))).toBe('summer')
    expect(seasonOf(new Date(2027, 10, 1))).toBe('winter')
  })

  it('les plages habituelles ignorent la clé seasons', () => {
    expect(parseOffpeakHours(config)).toEqual([{ startHour: 22, startMin: 0, endHour: 6, endMin: 0 }])
  })

  it('plages selon la saison, à partir de la date de début', () => {
    const at = offpeakRangesResolver(config)
    const midi = (d: Date) => isOffpeakTime(12, 0, at(d))
    const soir = (d: Date) => isOffpeakTime(23, 0, at(d))
    expect(midi(new Date(2026, 9, 31))).toBe(false) // avant la date de début : habituelles
    expect(soir(new Date(2026, 9, 31))).toBe(true)
    expect(midi(new Date(2027, 6, 14))).toBe(true) // été
    expect(soir(new Date(2027, 6, 14))).toBe(false)
    expect(midi(new Date(2027, 0, 14))).toBe(false) // hiver
    expect(soir(new Date(2027, 0, 14))).toBe(true)
  })

  it('sans saison saisie : plages habituelles', () => {
    expect(parseOffpeakSeasons({ ranges: ['22:00-06:00'] })).toBeNull()
    expect(parseOffpeakSeasons({ ranges: ['22:00-06:00'], seasons: { summer: [], winter: [] } })).toBeNull()
    const at = offpeakRangesResolver({ ranges: ['22:00-06:00'], seasons: { summer: ['11:00-17:00'] } })
    expect(at(new Date(2027, 0, 14))).toEqual(parseOffpeakHours(['22:00-06:00']))
    expect(isOffpeakTime(12, 0, at(new Date(2020, 5, 1)))).toBe(true) // pas de date de début
  })
})
