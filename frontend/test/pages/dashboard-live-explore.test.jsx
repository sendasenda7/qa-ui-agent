import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Dashboard from '../../src/pages/Dashboard.jsx'
import LiveRuns from '../../src/pages/LiveRuns.jsx'
import Explore from '../../src/pages/Explore.jsx'
import * as api from '../../src/lib/api.js'

vi.mock('../../src/lib/api.js', () => ({
  getRuns: vi.fn(), crawlOnly: vi.fn(), screenshotUrl: (p) => (p ? `http://api/${p}` : null),
}))

beforeEach(() => vi.clearAllMocks())

const runs = [
  { runId: 5, ticketSummary: 'Profil', url: 'https://b.fr', status: 'running', phase: 'running', stepsRun: 1, stepsTotal: 4 },
  { runId: 4, ticketSummary: 'Panier', url: 'https://c.fr', status: 'error', warningsCount: 0 },
  { runId: 3, ticketSummary: 'Recherche', url: 'https://d.fr', status: 'failed', stepsPassed: 1, stepsTotal: 3, warningsCount: 2 },
  { runId: 2, ticketSummary: 'Connexion', url: 'https://a.fr', status: 'passed', stepsPassed: 3, stepsTotal: 3 },
]
const inRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('Dashboard', () => {
  it('chiffres, taux de réussite et liste des runs', async () => {
    api.getRuns.mockResolvedValue(runs)
    inRouter(<Dashboard />)
    expect(screen.getByText('Chargement des runs...')).toBeInTheDocument()
    expect(await screen.findByText('Tests totaux')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument() // 1 réussi sur 4
    expect(screen.getByText('Profil')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Nouveau test/ })).toHaveAttribute('href', '/new-run')
  })

  it('filtres : en cours, échoués (échec + erreur), avertissements, tous', async () => {
    api.getRuns.mockResolvedValue(runs)
    inRouter(<Dashboard />)
    await screen.findByText('Connexion')

    await userEvent.click(screen.getByRole('button', { name: 'En cours' }))
    expect(screen.getByText('Profil')).toBeInTheDocument()
    expect(screen.queryByText('Connexion')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Échoués' }))
    expect(screen.getByText('Panier')).toBeInTheDocument()
    expect(screen.getByText('Recherche')).toBeInTheDocument()
    expect(screen.queryByText('Connexion')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Avertissements' }))
    expect(screen.getByText('Recherche')).toBeInTheDocument()
    expect(screen.queryByText('Panier')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Tous' }))
    expect(screen.getByText('Connexion')).toBeInTheDocument()
  })

  it('recherche par ticket ou URL, et message si rien ne correspond', async () => {
    api.getRuns.mockResolvedValue(runs)
    inRouter(<Dashboard />)
    await screen.findByText('Connexion')
    await userEvent.type(screen.getByPlaceholderText(/Rechercher/), 'c.fr')
    expect(screen.getByText('Panier')).toBeInTheDocument()
    expect(screen.queryByText('Connexion')).toBeNull()
    await userEvent.clear(screen.getByPlaceholderText(/Rechercher/))
    await userEvent.type(screen.getByPlaceholderText(/Rechercher/), 'zzz')
    expect(screen.getByText('Aucun run ne correspond à ce filtre.')).toBeInTheDocument()
  })

  it('aucun run : invite à lancer le premier test, sans taux', async () => {
    api.getRuns.mockResolvedValue([])
    inRouter(<Dashboard />)
    expect(await screen.findByText(/Aucun run pour l'instant/)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Rechercher/)).toBeNull()
  })

  it('affiche l\'erreur du serveur', async () => {
    api.getRuns.mockRejectedValue(new Error('Serveur KO'))
    inRouter(<Dashboard />)
    expect(await screen.findByText(/Serveur KO/)).toBeInTheDocument()
  })

  it('limite la liste à 10 runs', async () => {
    api.getRuns.mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({ runId: i + 1, ticketSummary: `Ticket ${i + 1}`, url: 'u', status: 'passed', stepsPassed: 1, stepsTotal: 1 })))
    inRouter(<Dashboard />)
    await screen.findByText('Ticket 1')
    expect(screen.getAllByText(/^Ticket \d+$/)).toHaveLength(10)
  })
})

describe('LiveRuns', () => {
  const renderLive = () => render(
    <MemoryRouter>
      <Routes><Route path="/" element={<LiveRuns />} /></Routes>
    </MemoryRouter>,
  )

  it('sépare les runs en cours des terminés et mène au bon écran', async () => {
    api.getRuns.mockResolvedValue(runs)
    renderLive()
    expect(await screen.findByText('Profil')).toBeInTheDocument()
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(links).toContain('/live-runs/5') // en cours
    expect(links).toContain('/reports/3') // échoué : rapport
    expect(links).toContain('/reports/2') // réussi : rapport
    expect(links).toContain('/live-runs/4') // en erreur : page de suivi
    expect(screen.getByText('Terminés récemment')).toBeInTheDocument()
  })

  it('aucun test en cours : propose d\'en lancer un', async () => {
    api.getRuns.mockResolvedValue([runs[3]])
    renderLive()
    expect(await screen.findByText(/Aucun test en cours/)).toBeInTheDocument()
  })

  it('erreur puis rafraîchissement automatique', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      api.getRuns.mockRejectedValueOnce(new Error('coupure')).mockResolvedValue(runs)
      renderLive()
      expect(await screen.findByText(/coupure/)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
      expect(await screen.findByText('Profil')).toBeInTheDocument()
      expect(screen.queryByText(/coupure/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Explore', () => {
  const crawl = {
    title: 'Connexion', elementCount: 2, durationMs: 850, screenshotPath: 'debug-screenshots/c.png',
    elements: [
      { index: 0, accessibleName: 'Email', tag: 'input', selector: '#email', selectorStrategy: 'id', detectedBy: 'role' },
      { index: 1, accessibleName: '', tag: 'div', selector: 'div.btn', selectorStrategy: 'position', detectedBy: 'heuristique : cursor', disabledLooking: true },
    ],
  }
  const renderExplore = () => render(<MemoryRouter><Explore /></MemoryRouter>)

  it('explore l\'URL saisie puis détaille les éléments', async () => {
    api.crawlOnly.mockResolvedValue(crawl)
    renderExplore()
    const input = screen.getByPlaceholderText(/staging/)
    await userEvent.clear(input)
    await userEvent.type(input, 'https://exemple.fr')
    await userEvent.click(screen.getByRole('button', { name: 'Explorer' }))
    expect(api.crawlOnly).toHaveBeenCalledWith({ url: 'https://exemple.fr' })
    expect(await screen.findByText('850ms')).toBeInTheDocument()
    expect(screen.getByText('Éléments interactifs détectés (2)')).toBeInTheDocument()
    expect(screen.getByText('#email')).toBeInTheDocument()
    expect(screen.getByText('sans libellé')).toBeInTheDocument()
    expect(screen.getByText('heuristique')).toBeInTheDocument()
    expect(screen.getByText('désactivé au chargement')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', 'http://api/debug-screenshots/c.png')
    expect(screen.getByRole('link', { name: /Générer un scénario/ })).toHaveAttribute('href', '/new-run')
  })

  it('erreur du crawler', async () => {
    api.crawlOnly.mockRejectedValue(new Error('Adresse refusée'))
    renderExplore()
    await userEvent.click(screen.getByRole('button', { name: 'Explorer' }))
    expect(await screen.findByText(/Adresse refusée/)).toBeInTheDocument()
  })

  it('sans capture ni heuristique', async () => {
    api.crawlOnly.mockResolvedValue({ ...crawl, screenshotPath: null, elements: [crawl.elements[0]], elementCount: 1 })
    renderExplore()
    await userEvent.click(screen.getByRole('button', { name: 'Explorer' }))
    await screen.findByText('Éléments interactifs détectés (1)')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText('heuristique')).toBeNull()
  })
})
