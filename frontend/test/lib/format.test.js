import { describe, it, expect } from 'vitest'
import { formatDuration, formatClock } from '../../src/lib/format.js'
import { ordinalFr } from '../../src/lib/attempts.js'
import { BROWSER_ENGINES, DEFAULT_BROWSER_ENGINE, browserEngineLabel } from '../../src/lib/browser-engines.js'

describe('formatDuration', () => {
  it('affiche les secondes seules sous une minute', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(4400)).toBe('4s')
  })
  it('affiche minutes et secondes au-delà', () => {
    expect(formatDuration(62000)).toBe('1m 2s')
    expect(formatDuration(120000)).toBe('2m 0s')
  })
})

describe('formatClock', () => {
  it('formate en mm:ss', () => {
    expect(formatClock(62000)).toBe('01:02')
    expect(formatClock(0)).toBe('00:00')
  })
  it('ne descend jamais sous zéro', () => {
    expect(formatClock(-5000)).toBe('00:00')
  })
})

describe('ordinalFr', () => {
  it('1er puis Ne', () => {
    expect(ordinalFr(1)).toBe('1er')
    expect(ordinalFr(2)).toBe('2e')
    expect(ordinalFr(3)).toBe('3e')
  })
})

describe('browser-engines', () => {
  it('propose chromium par défaut', () => {
    expect(DEFAULT_BROWSER_ENGINE).toBe('chromium')
    expect(BROWSER_ENGINES.map((e) => e.id)).toEqual(['chromium', 'firefox', 'webkit'])
  })
  it('donne un libellé, avec repli sur Chromium pour les anciens runs', () => {
    expect(browserEngineLabel('firefox')).toBe('Firefox')
    expect(browserEngineLabel(undefined)).toBe('Chromium')
    expect(browserEngineLabel('opera')).toBe('opera')
  })
})
