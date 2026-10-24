import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Sidebar from '../../src/layout/Sidebar.jsx'
import TopBar from '../../src/layout/TopBar.jsx'
import BottomNav from '../../src/layout/BottomNav.jsx'
import AppShell from '../../src/layout/AppShell.jsx'
import PipelineStrip from '../../src/components/PipelineStrip.jsx'
import PipelineTabs from '../../src/components/PipelineTabs.jsx'
import BrowserFrame from '../../src/components/BrowserFrame.jsx'

const inRouter = (ui, path = '/') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>)

beforeEach(() => localStorage.clear())

describe('Sidebar', () => {
  it('liste les écrans, dont l\'historique, et marque la page courante', () => {
    inRouter(<Sidebar />, '/history')
    for (const label of ['Dashboard', 'Explore', 'New Run', 'Live Runs', 'Visual/RTL', 'Historique', 'Reports']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: 'Historique' })).toHaveAttribute('href', '/history')
    expect(screen.getByRole('link', { name: 'Historique' })).toHaveClass('bg-surface-raised')
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveClass('bg-surface-raised')
  })

  it('la déconnexion efface le token et prévient l\'appli', async () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    const onLogout = vi.fn()
    inRouter(<Sidebar onLogout={onLogout} />)
    await userEvent.click(screen.getByRole('button', { name: /Déconnexion/ }))
    expect(localStorage.getItem('qa-ui-agent-token')).toBeNull()
    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  it('la déconnexion marche sans callback', async () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    inRouter(<Sidebar />)
    await userEvent.click(screen.getByRole('button', { name: /Déconnexion/ }))
    expect(localStorage.getItem('qa-ui-agent-token')).toBeNull()
  })
})

describe('TopBar', () => {
  it('affiche le produit et se déconnecte', async () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    const onLogout = vi.fn()
    render(<TopBar onLogout={onLogout} />)
    expect(screen.getByText('QA-UI AGENT')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Déconnexion/ }))
    expect(localStorage.getItem('qa-ui-agent-token')).toBeNull()
    expect(onLogout).toHaveBeenCalled()
  })
  it('sans callback', async () => {
    render(<TopBar />)
    await userEvent.click(screen.getByRole('button', { name: /Déconnexion/ }))
  })
})

describe('BottomNav', () => {
  it('5 destinations, « New Run » en bouton principal', () => {
    inRouter(<BottomNav />, '/reports')
    expect(screen.getAllByRole('link')).toHaveLength(5)
    expect(screen.getByRole('link', { name: 'New Run' })).toHaveAttribute('href', '/new-run')
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveClass('text-text')
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveClass('text-text-faint')
  })
})

describe('AppShell', () => {
  it('enveloppe le contenu avec les barres de navigation', () => {
    inRouter(<AppShell><p>contenu de la page</p></AppShell>)
    expect(screen.getByText('contenu de la page')).toBeInTheDocument()
    expect(screen.getAllByText('QA-UI AGENT').length).toBeGreaterThanOrEqual(1)
  })
})

describe('PipelineStrip et PipelineTabs', () => {
  it('la frise mène aux bons écrans', () => {
    inRouter(<PipelineStrip />)
    expect(screen.getByRole('link', { name: /Explore/ })).toHaveAttribute('href', '/explore')
    expect(screen.getByRole('link', { name: /RTL/ })).toHaveAttribute('href', '/visual-rtl')
    expect(screen.getAllByRole('link')).toHaveLength(5)
  })
  it('les onglets distinguent étape faite, active et à venir', () => {
    render(<PipelineTabs currentStep={3} />)
    expect(screen.getByText('1. Ticket')).toHaveClass('text-accent-blue')
    expect(screen.getByText('3. AI Plan')).toHaveClass('bg-surface-raised')
    expect(screen.getByText('6. Report')).toHaveClass('text-text-faint')
  })
})

describe('BrowserFrame', () => {
  it('sans capture : message d\'attente', () => {
    render(<BrowserFrame url="https://a.fr" />)
    expect(screen.getByText('https://a.fr')).toBeInTheDocument()
    expect(screen.getByText(/première capture apparaîtra/)).toBeInTheDocument()
    expect(screen.queryByText('EN DIRECT')).toBeNull()
  })
  it('en direct, avec capture et légende', () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    render(<BrowserFrame url="https://a.fr" screenshot="run-screenshots/1-step0.png" caption="Étape 1" isLive />)
    expect(screen.getByText('EN DIRECT')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', expect.stringContaining('/screenshots/1-step0.png'))
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'Étape 1')
  })
  it('capture sans légende : texte alternatif par défaut', () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    render(<BrowserFrame url="u" screenshot="run-screenshots/1.png" />)
    expect(screen.getByRole('img')).toHaveAttribute('alt', expect.stringMatching(/Dernière capture/))
  })
})
