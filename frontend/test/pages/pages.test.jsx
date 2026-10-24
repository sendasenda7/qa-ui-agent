import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import History from '../../src/pages/History.jsx'
import Login from '../../src/pages/Login.jsx'
import * as api from '../../src/lib/api.js'

vi.mock('../../src/lib/api.js', () => ({ getHistory: vi.fn(), login: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const run = (id, status = 'passed', durationMs = 4000) => ({ runId: id, status, durationMs, startedAt: '2026-01-01T10:00:00Z', flaky: false })

const history = {
  overall: { total: 4, passed: 3, failed: 1, errored: 0, passRate: 75, distinctTickets: 1, avgDurationMs: 65000, flakyRuns: 1 },
  recent: [run('1'), run('2', 'failed')],
  tickets: [{
    url: 'https://helpify.fr/login', browserEngine: 'chromium', ticketSummary: 'Se connecter', trend: 'regression',
    slower: true, runs: [run('1'), run('2', 'failed')], total: 4, passRate: 75, avgDurationMs: 65000,
    lastFailureCode: 'E-ELM-001', lastRunId: '2',
  }],
  topErrors: [{ code: 'E-ELM-001', label: 'Élément introuvable', example: '#btn', count: 2, lastRunId: '2' }],
}

function renderHistory() {
  return render(<MemoryRouter><History /></MemoryRouter>)
}

describe('page Historique', () => {
  it('affiche le chargement puis les chiffres et tickets', async () => {
    api.getHistory.mockResolvedValue(history)
    renderHistory()
    expect(screen.getByText('Chargement...')).toBeInTheDocument()
    expect(await screen.findByText('Se connecter')).toBeInTheDocument()
    expect(screen.getByText('75 %')).toBeInTheDocument()
    expect(screen.getByText('1m 5s')).toBeInTheDocument()
    expect(screen.getByText('De plus en plus lent')).toBeInTheDocument()
    expect(screen.getByText(/dernier échec E-ELM-001/)).toBeInTheDocument()
    expect(screen.getByText('Élément introuvable')).toBeInTheDocument()
    expect(screen.getByText('2 fois')).toHaveAttribute('href', '/reports/2')
  })

  it('historique vide', async () => {
    api.getHistory.mockResolvedValue({ overall: { total: 0 }, recent: [], tickets: [], topErrors: [] })
    renderHistory()
    expect(await screen.findByText(/Aucun run terminé/)).toBeInTheDocument()
  })

  it('erreur API', async () => {
    api.getHistory.mockRejectedValue(new Error('Serveur KO'))
    renderHistory()
    expect(await screen.findByText('Serveur KO')).toBeInTheDocument()
  })
})

describe('page Login', () => {
  it('bouton désactivé tant que le mot de passe est vide, puis succès', async () => {
    api.login.mockResolvedValue()
    const onSuccess = vi.fn()
    render(<Login onSuccess={onSuccess} />)
    const button = screen.getByRole('button', { name: 'Se connecter' })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('Mot de passe'), 'secret')
    expect(button).toBeEnabled()
    await userEvent.click(button)
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    expect(api.login).toHaveBeenCalledWith('secret')
  })

  it('affiche l\'erreur si le mot de passe est refusé', async () => {
    api.login.mockRejectedValue(new Error('Mot de passe incorrect'))
    const onSuccess = vi.fn()
    render(<Login onSuccess={onSuccess} />)
    await userEvent.type(screen.getByPlaceholderText('Mot de passe'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))
    expect(await screen.findByText('Mot de passe incorrect')).toBeInTheDocument()
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
