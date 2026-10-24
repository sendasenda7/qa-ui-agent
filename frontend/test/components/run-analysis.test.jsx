import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RunAnalysis from '../../src/components/RunAnalysis.jsx'

const renderAnalysis = (options, runResult) =>
  render(<MemoryRouter><RunAnalysis options={options} runResult={runResult} /></MemoryRouter>)

describe('RunAnalysis : RTL', () => {
  it('ancien run sans options : tout est « Non activé »', () => {
    renderAnalysis(undefined, {})
    expect(screen.getAllByText('Non activé').length).toBeGreaterThanOrEqual(2)
  })
  it('activé mais sans résultat', () => {
    renderAnalysis({ checkRtl: true }, {})
    expect(screen.getByText('RTL & localisation FR/AR')).toBeInTheDocument()
    expect(screen.getAllByText('En attente').length).toBeGreaterThanOrEqual(1)
  })
  it('analyse impossible', () => {
    renderAnalysis({ checkRtl: true }, { rtl: { status: 'error', error: 'Aucun bouton de langue' } })
    expect(screen.getByText('Aucun bouton de langue')).toBeInTheDocument()
    expect(screen.getByText('Analyse impossible')).toBeInTheDocument()
  })
  it('aucune anomalie', () => {
    renderAnalysis({ checkRtl: true }, { rtl: { status: 'done', report: { findingsCount: 0, findings: [], frDir: 'ltr', arDir: 'rtl', elementsComparedCount: 12 } } })
    expect(screen.getByText('Aucune anomalie')).toBeInTheDocument()
    expect(screen.getByText(/12 éléments comparés/)).toBeInTheDocument()
  })
  it('anomalies listées avec leur sélecteur', () => {
    renderAnalysis({ checkRtl: true }, { rtl: { status: 'done', report: {
      findingsCount: 2, frDir: 'ltr', arDir: 'ltr', elementsComparedCount: 5,
      findings: [{ description: 'Texte non traduit', selector: '#titre' }, { description: 'Direction incorrecte' }],
    } } })
    expect(screen.getByText('2 anomalie(s)')).toBeInTheDocument()
    expect(screen.getByText('Texte non traduit')).toBeInTheDocument()
    expect(screen.getByText('#titre')).toBeInTheDocument()
    expect(screen.getByText('Direction incorrecte')).toBeInTheDocument()
  })
})

describe('RunAnalysis : régression visuelle', () => {
  const opts = { checkVisualDiff: true }
  it('erreur et absence de référence', () => {
    const { unmount } = renderAnalysis(opts, { visualDiff: { status: 'error', error: 'PNG corrompu' } })
    expect(screen.getByText('PNG corrompu')).toBeInTheDocument()
    unmount()
    renderAnalysis(opts, { visualDiff: { status: 'no_baseline', reason: 'Premier run de ce ticket' } })
    expect(screen.getByText('Pas de référence')).toBeInTheDocument()
    expect(screen.getByText('Premier run de ce ticket')).toBeInTheDocument()
  })
  it('aucune régression', () => {
    renderAnalysis(opts, { visualDiff: { status: 'done', baselineRunId: 7, report: { stepCount: 3, comparedStepCount: 3, hasRegressions: false, regressionCount: 0, maxDiffPercent: 0.1, warnings: [], steps: [] } } })
    expect(screen.getByText('Aucune régression')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#7' })).toHaveAttribute('href', '/reports/7')
    expect(screen.getByText(/écart maximal 0.1%/)).toBeInTheDocument()
  })
  it('rien de comparable : pas de faux verdict rassurant', () => {
    renderAnalysis(opts, { visualDiff: { status: 'done', baselineRunId: 7, report: { stepCount: 2, comparedStepCount: 0, hasRegressions: false, regressionCount: 0, maxDiffPercent: null, warnings: ['Scénarios différents'], steps: [] } } })
    expect(screen.getByText('Non comparable')).toBeInTheDocument()
    expect(screen.getByText('Scénarios différents')).toBeInTheDocument()
  })
  it('ancien rapport sans compteur de comparaison', () => {
    renderAnalysis(opts, { visualDiff: { status: 'done', baselineRunId: 7, report: { stepCount: 2, hasRegressions: false, regressionCount: 0, maxDiffPercent: 0, warnings: [], steps: [] } } })
    expect(screen.getByText('Aucune régression')).toBeInTheDocument()
  })
  it('régressions : étapes concernées et image de différences', () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    renderAnalysis(opts, { visualDiff: { status: 'done', baselineRunId: 7, report: {
      stepCount: 2, comparedStepCount: 2, hasRegressions: true, regressionCount: 1, maxDiffPercent: 27, warnings: [],
      steps: [{ index: 0, isRegression: false }, { index: 1, isRegression: true, description: 'Cliquer', diffPercent: 27, diffImagePath: 'diff-screenshots/d.png' }],
    } } })
    expect(screen.getByText('1 régression(s)')).toBeInTheDocument()
    expect(screen.getByText('Étape 2 : Cliquer')).toBeInTheDocument()
    expect(screen.getByText('27% de pixels différents')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', expect.stringContaining('/diff-screenshots/d.png'))
  })
})
