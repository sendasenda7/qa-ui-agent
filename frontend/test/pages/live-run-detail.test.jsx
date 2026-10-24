import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import LiveRunDetail from '../../src/pages/LiveRunDetail.jsx'

const polling = vi.hoisted(() => ({ value: { data: null, error: null } }))
vi.mock('../../src/hooks/useRunPolling.js', () => ({ useRunPolling: () => polling.value }))

beforeEach(() => localStorage.clear())

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/live-runs/42']}>
      <Routes><Route path="/live-runs/:id" element={<LiveRunDetail />} /></Routes>
    </MemoryRouter>,
  )
}
const data = (runResult, extra = {}) => ({
  scenario: { ticketSummary: 'Connexion', steps: [{ description: 'Ouvrir', type: 'navigate' }, { description: 'Cliquer', type: 'click', selector: '#go' }] },
  ticketText: 'Vérifier la connexion',
  options: {},
  runResult: { runId: 42, url: 'https://staging.helpify.tn/auth', browserEngine: 'firefox', startedAt: '2026-01-01T10:00:00.000Z', results: [], ...runResult },
  ...extra,
})

describe('LiveRunDetail', () => {
  it('erreur de lecture', () => {
    polling.value = { data: null, error: 'Serveur KO' }
    renderPage()
    expect(screen.getByText(/Serveur KO/)).toBeInTheDocument()
  })

  it('chargement', () => {
    polling.value = { data: null, error: null }
    renderPage()
    expect(screen.getByText('Chargement du run...')).toBeInTheDocument()
  })

  it('run en cours : titre, progression, navigateur et fenêtre en direct', () => {
    polling.value = { error: null, data: data({
      status: 'running', phase: 'running', stepsRun: 1, stepsTotal: 2, crawl: { elementCount: 4 },
      currentStep: { index: 1, description: 'Cliquer' },
      results: [{ index: 0, status: 'passed', description: 'Ouvrir', durationMs: 120, screenshot: 'run-screenshots/42-step0.png' }],
    }) }
    localStorage.setItem('qa-ui-agent-token', 'tok')
    renderPage()
    expect(screen.getByText('Test en cours')).toBeInTheDocument()
    expect(screen.getByText('RUN #42')).toBeInTheDocument()
    expect(screen.getByText('Firefox')).toBeInTheDocument()
    expect(screen.getByText('staging.helpify.tn')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByText('1 sur 2 étapes (50%)')).toBeInTheDocument()
    expect(screen.getByText('EN DIRECT')).toBeInTheDocument()
    expect(screen.getByText('Étape 2 : Cliquer')).toBeInTheDocument()
    expect(screen.queryByText('Voir le rapport')).toBeNull()
    expect(screen.getByText('Vérifier la connexion')).toBeInTheDocument()
  })

  it('run réussi : lien vers le rapport, durée prise sur les dates, instabilité signalée', () => {
    polling.value = { error: null, data: data({
      status: 'passed', phase: 'done', stepsRun: 2, stepsTotal: 2, stepsPassed: 2, flakySteps: 1,
      finishedAt: '2026-01-01T10:01:05.000Z', crawl: { elementCount: 4 },
      results: [{ index: 0, status: 'passed', description: 'Ouvrir', durationMs: 100 }, { index: 1, status: 'passed', description: 'Cliquer', durationMs: 100 }],
    }) }
    renderPage()
    expect(screen.getByText('Test terminé')).toBeInTheDocument()
    expect(screen.getByText('01:05')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Voir le rapport' })).toHaveAttribute('href', '/reports/42')
    expect(screen.getByText(/Test instable/)).toBeInTheDocument()
    expect(screen.queryByText('EN DIRECT')).toBeNull()
  })

  it('ancien run sans date de fin : durée = somme des étapes', () => {
    polling.value = { error: null, data: data({
      status: 'failed', phase: 'done', stepsRun: 2, stepsTotal: 2, stepsPassed: 1,
      results: [{ index: 0, status: 'passed', description: 'Ouvrir', durationMs: 30000 }, { index: 1, status: 'failed', description: 'Cliquer', durationMs: 31000, error: 'Introuvable' }],
    }) }
    renderPage()
    expect(screen.getByText('01:01')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Voir le rapport' })).toBeInTheDocument()
  })

  it('run interrompu avant la première étape : pas de fenêtre vide, erreur et lien pour relancer', () => {
    polling.value = { error: null, data: data({
      status: 'error', phase: 'error', stepsRun: 0, stepsTotal: 0, error: 'Aucun élément détecté sur la page',
      finishedAt: '2026-01-01T10:00:03.000Z',
    }, { scenario: { ticketSummary: 'x', steps: [] }, ticketText: undefined }) }
    renderPage()
    expect(screen.getByText('Test interrompu')).toBeInTheDocument()
    expect(screen.getAllByText('En attente du scénario').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Aucun élément détecté sur la page')).toBeInTheDocument()
    expect(screen.queryByText(/première capture/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Lancer un nouveau test' })).toHaveAttribute('href', '/new-run')
  })

  it('scénario absent (ancien run) : pas de plantage', () => {
    polling.value = { error: null, data: data({ status: 'passed', phase: 'done', stepsRun: 0, stepsTotal: 0, results: undefined, finishedAt: '2026-01-01T10:00:01.000Z' }, { scenario: {} }) }
    renderPage()
    expect(screen.getByText('Test terminé')).toBeInTheDocument()
  })
})
