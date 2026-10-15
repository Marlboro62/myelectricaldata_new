import { useMemo } from 'react'
import type { ProductionAPIResponse, DetailAPIResponse } from '../types/production.types'
import { getIntervalLength, getReadings, getUnit, hasReadings, readingEnergyWh, readingHours } from '@/utils/enedisMeasure'

interface UseProductionCalcsProps {
  productionData: ProductionAPIResponse | null
  detailData: DetailAPIResponse | null
}

export function useProductionCalcs({
  productionData,
  detailData,
}: UseProductionCalcsProps) {

  // Process production data for charts
  const chartData = useMemo(() => {
    if (!hasReadings(productionData)) {
      return { byYear: [], byMonth: [], byMonthComparison: [], total: 0, years: [], unit: 'W' }
    }

    const readings = getReadings(productionData)
    // Mesure quotidienne : énergie en Wh, jamais multipliée par le pas (MED-24)
    const unit = getUnit(productionData) || 'Wh'
    const intervalLength = getIntervalLength(productionData) || 'P1D'


    const monthlyData: Record<string, number> = {}
    const monthYearData: Record<string, Record<string, number>> = {}
    let totalProduction = 0

    // Find the most recent date in the actual data
    let mostRecentDate = new Date(0)
    readings.forEach((reading) => {
      const dateStr = reading.date?.split('T')[0] || reading.date
      if (dateStr) {
        const readingDate = new Date(dateStr)
        if (readingDate > mostRecentDate) {
          mostRecentDate = readingDate
        }
      }
    })

    // Define 365-day periods (sliding windows)
    const period1End = mostRecentDate
    const period1Start = new Date(mostRecentDate.getTime() - 365 * 24 * 60 * 60 * 1000)
    const period2End = new Date(mostRecentDate.getTime() - 365 * 24 * 60 * 60 * 1000)
    const period2Start = new Date(mostRecentDate.getTime() - 730 * 24 * 60 * 60 * 1000)
    const period3End = new Date(mostRecentDate.getTime() - 730 * 24 * 60 * 60 * 1000)
    const period3Start = new Date(mostRecentDate.getTime() - 1095 * 24 * 60 * 60 * 1000)

    const periods = [
      {
        label: String(period1End.getFullYear()),
        startDaysAgo: 0,
        endDaysAgo: 365,
        startDate: period1Start,
        endDate: period1End
      },
      {
        label: String(period2End.getFullYear()),
        startDaysAgo: 365,
        endDaysAgo: 730,
        startDate: period2Start,
        endDate: period2End
      },
      {
        label: String(period3End.getFullYear()),
        startDaysAgo: 730,
        endDaysAgo: 1095,
        startDate: period3Start,
        endDate: period3End
      }
    ]

    const periodData: Record<string, { value: number, startDate: Date, endDate: Date }> = {}
    const periodMonthlyData: Record<string, Record<string, number>> = {}

    readings.forEach((reading) => {
      const rawValue = reading.value
      const dateStr = reading.date?.split('T')[0] || reading.date

      if (!dateStr || isNaN(rawValue)) return

      // Énergie (Wh) du relevé, au pas qui lui est propre (MED-24)
      const value = readingEnergyWh(reading, unit, intervalLength)
      const readingDate = new Date(dateStr)
      const year = dateStr.substring(0, 4)
      const month = dateStr.substring(0, 7)
      const monthOnly = dateStr.substring(5, 7)

      periods.forEach(period => {
        if (readingDate >= period.startDate && readingDate <= period.endDate) {
          if (!periodData[period.label]) {
            periodData[period.label] = {
              value: 0,
              startDate: period.startDate,
              endDate: period.endDate
            }
          }
          periodData[period.label].value += value

          if (!periodMonthlyData[period.label]) {
            periodMonthlyData[period.label] = {}
          }
          periodMonthlyData[period.label][month] = (periodMonthlyData[period.label][month] || 0) + value
        }
      })

      monthlyData[month] = (monthlyData[month] || 0) + value

      if (!monthYearData[monthOnly]) {
        monthYearData[monthOnly] = {}
      }
      monthYearData[monthOnly][year] = (monthYearData[monthOnly][year] || 0) + value

      totalProduction += value
    })

    const byYear = Object.entries(periodData)
      .map(([label, data]) => ({
        year: label,
        production: Math.round(data.value),
        startDate: data.startDate,
        endDate: data.endDate
      }))
      .reverse()

    const years = Object.keys(monthYearData).length > 0
      ? Object.keys(readings.reduce((acc: any, r: any) => {
          const year = r.date?.substring(0, 4)
          if (year) acc[year] = true
          return acc
        }, {})).sort()
      : []

    const byMonth = Object.entries(monthlyData)
      .map(([month, value]) => ({
        month,
        monthLabel: new Date(month + '-01').toLocaleDateString('fr-FR', { year: 'numeric', month: 'short' }),
        production: Math.round(value),
      }))
      .sort((a, b) => a.month.localeCompare(b.month))

    const monthNames = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
    const monthLabels = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc']

    const byMonthComparison = monthNames.map((monthNum, idx) => {
      const row: any = {
        month: monthNum,
        monthLabel: monthLabels[idx],
      }

      years.forEach(year => {
        const value = monthYearData[monthNum]?.[year] || 0
        row[year] = Math.round(value)
      })

      return row
    })

    const yearsByPeriod = periods.map(period => {
      const periodMonths = periodMonthlyData[period.label] || {}
      const byMonth = Object.entries(periodMonths)
        .map(([month, value]) => ({
          month,
          monthLabel: new Date(month + '-01').toLocaleDateString('fr-FR', { year: 'numeric', month: 'short' }),
          production: Math.round(value),
        }))
        .sort((a, b) => a.month.localeCompare(b.month))

      return {
        label: period.label,
        byMonth
      }
    }).reverse()

    return {
      byYear,
      byMonth,
      byMonthComparison,
      total: Math.round(totalProduction),
      years,
      yearsByPeriod,
      unit,
    }
  }, [productionData])

  // Process detailed production data by day
  const detailByDayData = useMemo(() => {
    if (!hasReadings(detailData)) {
      return []
    }

    const readings = getReadings(detailData)
    const unit = getUnit(detailData) || 'W'
    const intervalLength = getIntervalLength(detailData) || 'PT30M'

    const dayMap: Record<string, any[]> = {}

    readings.forEach((reading) => {
      if (!reading.date) return

      // Le backend horodate déjà chaque point au DÉBUT de son intervalle (shift_points_to_interval_start) :
      // ne pas le reculer une seconde fois, qui plus est du pas du premier point (MED-24)
      let measurementDateTime: Date

      if (reading.date.includes('T')) {
        measurementDateTime = new Date(reading.date)
      } else if (reading.date.includes(' ')) {
        measurementDateTime = new Date(reading.date.replace(' ', 'T'))
      } else {
        measurementDateTime = new Date(reading.date + 'T00:00:00')
      }

      const year = measurementDateTime.getFullYear()
      const month = String(measurementDateTime.getMonth() + 1).padStart(2, '0')
      const day = String(measurementDateTime.getDate()).padStart(2, '0')
      const hours = String(measurementDateTime.getHours()).padStart(2, '0')
      const minutes = String(measurementDateTime.getMinutes()).padStart(2, '0')

      const dateStr = `${year}-${month}-${day}`
      const time = `${hours}:${minutes}`

      if (!dayMap[dateStr]) {
        dayMap[dateStr] = []
      }

      const rawValue = reading.value
      const energyWh = readingEnergyWh(reading, unit, intervalLength)
      const energyKwh = energyWh / 1000
      const averagePowerW = energyWh / readingHours(reading, intervalLength)
      const averagePowerKw = averagePowerW / 1000

      dayMap[dateStr].push({
        time,
        power: averagePowerKw,
        energyWh,
        energyKwh,
        rawValue,
        datetime: measurementDateTime.toISOString(),
        apiDatetime: reading.date
      })
    })

    const days = Object.entries(dayMap)
      .map(([date, data]) => ({
        date,
        data: data.sort((a, b) => a.time.localeCompare(b.time)),
        totalEnergyKwh: data.reduce((sum, d) => sum + d.energyKwh, 0)
      }))
      .filter(day => day.data.length >= 40)
      .sort((a, b) => b.date.localeCompare(a.date))

    return days
  }, [detailData])

  return {
    chartData,
    detailByDayData,
  }
}
