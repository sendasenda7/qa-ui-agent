import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PurgedNotice from '../../src/components/PurgedNotice.jsx'
import StepFailure from '../../src/components/StepFailure.jsx'
import { hideBrokenImage } from '../../src/lib/images.js'

describe('PurgedNotice', () => {
  it('rien pour un run normal', () => {
    const { container } = render(<PurgedNotice runResult={{ status: 'passed' }} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('explique la suppression des captures', () => {
    render(<PurgedNotice runResult={{ artifactsPurgedAt: '2026-10-24T00:00:00.000Z' }} />)
    expect(screen.getByText(/supprimées le .* par le nettoyage automatique/)).toBeInTheDocument()
  })
  it('date illisible : la phrase reste correcte', () => {
    render(<PurgedNotice runResult={{ artifactsPurgedAt: 'n/importe/quoi' }} />)
    expect(screen.getByText(/supprimées par le nettoyage automatique/)).toBeInTheDocument()
  })
})

describe('images supprimées', () => {
  it('hideBrokenImage cache l\'image', () => {
    const img = document.createElement('img')
    hideBrokenImage({ currentTarget: img })
    expect(img.style.display).toBe('none')
  })
  it('une capture d\'échec introuvable est masquée', () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    render(<StepFailure result={{ error: 'x', failure: { code: 'E-ELM-001' }, failureScreenshot: 'run-screenshots/f.png' }} />)
    const img = screen.getByRole('img')
    fireEvent.error(img)
    expect(img).toHaveStyle({ display: 'none' })
  })
})
