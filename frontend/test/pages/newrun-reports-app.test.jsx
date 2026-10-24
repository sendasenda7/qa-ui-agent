import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import NewRun from '../../src/pages/NewRun.jsx'
import Reports from '../../src/pages/Reports.jsx'
import App from '../../src/App.jsx'
import * as api from '../../src/lib/api.js'

vi.mock('../../src/lib/api.js', () => ({
  startTestRun: vi.fn(), getRuns: vi.fn(), isLoggedIn: vi.fn(), login: vi.fn(),
}))
vi.mock('../../src/layout/AppShell.jsx', () => ({ default: ({ children }) => <div data-testid="shell">{children}</div> }))
vi.mock('../../src/pages/Dashboard.jsx', () => ({ default: () => <p>Tableau de bord</p> }))

beforeEach(() => vi.clearAllMocks())

function renderNewRun() {
  return render(
    <MemoryRouter initialEntries={['/new-run']}>
      <Routes>
        <Route path="/new-run" element={<NewRun />} />
        <Route path="/live-runs/:id" element={<p>Suivi du run</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('NewRun', () => {
  it('lancer est impossible sans ticket', () => {
    renderNewRun()
    expect(screen.getByRole('button', { name: 'Lancer le test' })).toBeDisabled()
  })

  it('les interrupteurs RTL, visuel, accessibilité et responsive sont activés par défaut, la relecture non', () => {
    renderNewRun()
    const states = screen.getAllByRole('switch').map((s) => s.getAttribute('aria-checked'))
    expect(states).toEqual(['true', 'true', 'true', 'true', 'false'])
  })

  it('envoie les options choisies puis ouvre le suivi du run', async () => {
    api.startTestRun.mockResolvedValue({ runId: 'r9' })
    renderNewRun()
    await userEvent.click(screen.getByRole('button', { name: /Tester le multi-langue/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Firefox' }))
    await userEvent.click(screen.getAllByRole('switch')[2]) // accessibilité off
    await userEvent.click(screen.getByRole('button', { name: 'Lancer le test' }))
    expect(await screen.findByText('Suivi du run')).toBeInTheDocument()
    expect(api.startTestRun).toHaveBeenCalledWith(expect.objectContaining({
      ticketText: 'Tester le multi-langue FR/AR', browserEngine: 'firefox',
      checkA11y: false, checkResponsive: true, checkRtl: true, checkVisualDiff: true, deepReview: false,
    }))
  })

  it('affiche l\'erreur du serveur', async () => {
    api.startTestRun.mockRejectedValue(new Error('URL refusée'))
    renderNewRun()
    await userEvent.click(screen.getByRole('button', { name: /Tester le multi-langue/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Lancer le test' }))
    expect(await screen.findByText(/URL refusée/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lancer le test' })).toBeEnabled()
  })
})

describe('Reports', () => {
  const runs = [
    { runId: '1', ticketSummary: 'Connexion', url: 'https://a.fr', status: 'passed' },
    { runId: '2', ticketSummary: 'Profil', url: 'https://b.fr', status: 'failed' },
  ]
  const renderReports = () => render(<MemoryRouter><Reports /></MemoryRouter>)

  it('liste puis filtre les rapports', async () => {
    api.getRuns.mockResolvedValue(runs)
    renderReports()
    expect(await screen.findByText('Connexion')).toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText(/Rechercher/), 'profil')
    expect(screen.queryByText('Connexion')).toBeNull()
    expect(screen.getByText('Profil')).toBeInTheDocument()
    await userEvent.clear(screen.getByPlaceholderText(/Rechercher/))
    await userEvent.type(screen.getByPlaceholderText(/Rechercher/), 'zzz')
    expect(screen.getByText(/Aucun rapport ne correspond à "zzz"/)).toBeInTheDocument()
  })

  it('aucun rapport / erreur', async () => {
    api.getRuns.mockResolvedValueOnce([])
    const first = renderReports()
    expect(await screen.findByText('Aucun rapport pour l\'instant.')).toBeInTheDocument()
    first.unmount()
    api.getRuns.mockRejectedValueOnce(new Error('KO'))
    renderReports()
    expect(await screen.findByText('KO')).toBeInTheDocument()
  })
})

describe('App', () => {
  it('affiche la connexion si personne n\'est connecté', () => {
    api.isLoggedIn.mockReturnValue(false)
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(screen.getByPlaceholderText('Mot de passe')).toBeInTheDocument()
  })

  it('affiche l\'appli puis revient à la connexion sur un 401', async () => {
    api.isLoggedIn.mockReturnValue(true)
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(screen.getByText('Tableau de bord')).toBeInTheDocument()
    act(() => { window.dispatchEvent(new Event('qa-ui-agent:unauthorized')) })
    await waitFor(() => expect(screen.getByPlaceholderText('Mot de passe')).toBeInTheDocument())
  })

  it('connexion réussie -> appli', async () => {
    api.isLoggedIn.mockReturnValue(false)
    api.login.mockResolvedValue()
    render(<MemoryRouter><App /></MemoryRouter>)
    await userEvent.type(screen.getByPlaceholderText('Mot de passe'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))
    expect(await screen.findByText('Tableau de bord')).toBeInTheDocument()
  })
})
