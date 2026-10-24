import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ReportDetail from '../../src/pages/ReportDetail.jsx'
import * as api from '../../src/lib/api.js'

vi.mock('../../src/lib/api.js', () => ({
  getRun: vi.fn(), replayRun: vi.fn(), saveRunNotes: vi.fn(), downloadRunExport: vi.fn(),
  screenshotUrl: (p) => (p ? `http://api/${p}` : null), traceUrl: () => null,
}))
const exportPdf = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/pdf-export.js', () => ({ exportRunReportToPdf: exportPdf }))

beforeEach(() => vi.clearAllMocks())

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reports/42']}>
      <Routes>
        <Route path="/reports/:id" element={<ReportDetail />} />
        <Route path="/live-runs/:id" element={<p>Page de suivi {''}</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

const report = (runResult = {}, extra = {}) => ({
  ticketUrl: 'https://linear.app/x/HELP-1',
  notes: '',
  options: {},
  scenario: {
    ticketSummary: 'Se connecter', confidence: 90, warnings: [],
    steps: [{ description: 'Ouvrir', type: 'navigate' }, { description: 'Cliquer', type: 'click', selector: '#go', selectorValid: false }],
  },
  runResult: {
    runId: 42, status: 'passed', startedAt: '2026-01-01T10:00:00.000Z', browserEngine: 'webkit',
    stepsPassed: 2, stepsTotal: 2,
    results: [
      { index: 0, status: 'passed', description: 'Ouvrir', type: 'navigate', durationMs: 1200, screenshot: 'run-screenshots/42-0.png' },
      { index: 1, status: 'passed', description: 'Cliquer', type: 'click', selector: '#go', durationMs: 800 },
    ],
    ...runResult,
  },
  ...extra,
})

describe('ReportDetail : affichage', () => {
  it('rapport réussi : en-tête, confiance, étapes, lien du ticket', async () => {
    api.getRun.mockResolvedValue(report())
    renderPage()
    expect(screen.getByText('Chargement du rapport...')).toBeInTheDocument()
    expect(await screen.findByText("Rapport d'exécution")).toBeInTheDocument()
    expect(screen.getByText('TERMINÉ')).toBeInTheDocument()
    expect(screen.getByText('RUN #42')).toBeInTheDocument()
    expect(screen.getByText('WebKit')).toBeInTheDocument()
    expect(screen.getByText('2s au total')).toBeInTheDocument()
    expect(screen.getByText('Confiance : 90%')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Voir le ticket/ })).toHaveAttribute('href', 'https://linear.app/x/HELP-1')
    expect(screen.getByText("click('#go')")).toBeInTheDocument()
    expect(screen.getByText('Étape 2')).toBeInTheDocument()
    expect(screen.getByText('sur 2 étapes générées')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Ouvrir' })).toHaveAttribute('src', 'http://api/run-screenshots/42-0.png')
  })

  it('avertissements : statut dédié et sélecteurs invalides comptés', async () => {
    api.getRun.mockResolvedValue(report({}, { scenario: { ticketSummary: 't', confidence: 60, warnings: ['Sélecteur inventé retiré'], steps: [{ selectorValid: false }, { selectorValid: false }] } }))
    renderPage()
    expect(await screen.findByText('TERMINÉ AVEC AVERTISSEMENTS')).toBeInTheDocument()
    expect(screen.getByText(/Sélecteur inventé retiré/)).toBeInTheDocument()
    expect(screen.getByText('Confiance : 60%')).toBeInTheDocument()
  })

  it.each([
    [{ status: 'failed' }, 'ÉCHOUÉ'],
    [{ status: 'error', error: 'Boom' }, 'ERREUR'],
  ])('statut %o -> %s', async (runResult, label) => {
    api.getRun.mockResolvedValue(report(runResult, { scenario: { ticketSummary: 't', warnings: [], steps: [] } }))
    renderPage()
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  it('confiance basse, sans ticket ni date de lien', async () => {
    api.getRun.mockResolvedValue(report({}, { ticketUrl: null, scenario: { ticketSummary: 't', confidence: 20, warnings: [], steps: [] } }))
    renderPage()
    expect(await screen.findByText('Confiance : 20%')).toBeInTheDocument()
    expect(screen.queryByText(/Voir le ticket/)).toBeNull()
  })

  it('un run encore en cours renvoie au suivi en direct', async () => {
    api.getRun.mockResolvedValue(report({ status: 'running' }))
    renderPage()
    expect(await screen.findByText(/Page de suivi/)).toBeInTheDocument()
  })

  it('erreur de chargement', async () => {
    api.getRun.mockRejectedValue(new Error('Run introuvable'))
    renderPage()
    expect(await screen.findByText('Run introuvable')).toBeInTheDocument()
  })

  it('note le nettoyage automatique d\'un vieux run', async () => {
    api.getRun.mockResolvedValue(report({ artifactsPurgedAt: '2026-10-24T00:00:00.000Z' }))
    renderPage()
    expect(await screen.findByText(/nettoyage automatique/)).toBeInTheDocument()
  })
})

describe('ReportDetail : exploration', () => {
  const withExploration = (exploration) => report({ crawl: { exploration } })
  it.each([
    [{ clicksPlanned: ['Suivant'], usedForPlan: true, newElementCount: 3, newTextCount: 2 }, /Page explorée après « Suivant » : 3 élément\(s\) et 2 texte\(s\)/],
    [{ clicksPlanned: ['A', 'B'], error: 'timeout' }, /Exploration après « A » puis « B » impossible : timeout/],
    [{ clicksPlanned: ['A'], failedClick: { description: 'Valider', reason: 'introuvable' } }, /clic « Valider » n'a pas pu être fait \(introuvable\)/],
    [{ clicksPlanned: ['A'] }, /rien de nouveau sur la page atteinte/],
  ])('bilan %#', async (exploration, expected) => {
    api.getRun.mockResolvedValue(withExploration(exploration))
    renderPage()
    expect(await screen.findByText(expected)).toBeInTheDocument()
  })
})

describe('ReportDetail : actions', () => {
  it('relancer le scénario ouvre le suivi du nouveau run', async () => {
    api.getRun.mockResolvedValue(report())
    api.replayRun.mockResolvedValue({ runId: 99 })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /Relancer ce scénario/ }))
    expect(api.replayRun).toHaveBeenCalledWith('42')
    expect(await screen.findByText(/Page de suivi/)).toBeInTheDocument()
  })

  it('relance refusée : erreur affichée', async () => {
    api.getRun.mockResolvedValue(report())
    api.replayRun.mockRejectedValue(new Error('Trop de runs'))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /Relancer ce scénario/ }))
    expect(await screen.findByText('Trop de runs')).toBeInTheDocument()
  })

  it('export PDF', async () => {
    api.getRun.mockResolvedValue(report())
    exportPdf.mockResolvedValue()
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /Exporter en PDF/ }))
    await waitFor(() => expect(exportPdf).toHaveBeenCalledTimes(1))
  })

  it('export PDF en échec', async () => {
    api.getRun.mockResolvedValue(report())
    exportPdf.mockRejectedValue(new Error('police manquante'))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /Exporter en PDF/ }))
    expect(await screen.findByText(/Export PDF impossible : police manquante/)).toBeInTheDocument()
  })

  it('exports JUnit et JSON, et leurs erreurs', async () => {
    api.getRun.mockResolvedValue(report())
    api.downloadRunExport.mockResolvedValueOnce().mockRejectedValueOnce(new Error('refusé'))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'JUnit XML' }))
    expect(api.downloadRunExport).toHaveBeenCalledWith('42', 'junit')
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(await screen.findByText('Export JSON impossible : refusé')).toBeInTheDocument()
  })

  it('l\'erreur d\'un export JUnit est nommée', async () => {
    api.getRun.mockResolvedValue(report())
    api.downloadRunExport.mockRejectedValue(new Error('KO'))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'JUnit XML' }))
    expect(await screen.findByText('Export JUnit impossible : KO')).toBeInTheDocument()
  })
})

describe('ReportDetail : notes', () => {
  it('enregistre les notes saisies', async () => {
    api.getRun.mockResolvedValue(report({}, { notes: 'ancienne note' }))
    api.saveRunNotes.mockResolvedValue({})
    renderPage()
    expect(await screen.findByText('Enregistré')).toBeInTheDocument()
    const area = screen.getByPlaceholderText(/faux positif/)
    expect(area).toHaveValue('ancienne note')
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull()
    await userEvent.type(area, ' + suite')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(api.saveRunNotes).toHaveBeenCalledWith('42', 'ancienne note + suite')
    expect(await screen.findByText('Enregistré')).toBeInTheDocument()
  })

  it('échec de l\'enregistrement : message et notes gardées', async () => {
    api.getRun.mockResolvedValue(report())
    api.saveRunNotes.mockRejectedValue(new Error('Disque plein'))
    renderPage()
    await userEvent.type(await screen.findByPlaceholderText(/faux positif/), 'abc')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText('Disque plein')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/faux positif/)).toHaveValue('abc')
  })
})
