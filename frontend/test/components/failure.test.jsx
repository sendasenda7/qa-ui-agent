import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import StepFailure from '../../src/components/StepFailure.jsx'
import TraceNote from '../../src/components/TraceNote.jsx'
import AccessibilityCard from '../../src/components/AccessibilityCard.jsx'

describe('StepFailure', () => {
  it('rien sans erreur', () => {
    const { container } = render(<StepFailure result={{}} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('ancien format : message brut', () => {
    render(<StepFailure result={{ error: 'vieux message' }} />)
    expect(screen.getByText('vieux message')).toBeInTheDocument()
  })
  it('format structuré complet', () => {
    render(<StepFailure result={{ error: 'Introuvable', failure: { code: 'E-ELM-001', label: 'Élément', expected: 'un bouton', found: 'rien', hint: 'Change le sélecteur', technical: 'stack...' } }} />)
    expect(screen.getByText('E-ELM-001')).toBeInTheDocument()
    expect(screen.getByText('un bouton')).toBeInTheDocument()
    expect(screen.getByText('rien')).toBeInTheDocument()
    expect(screen.getByText('Change le sélecteur')).toBeInTheDocument()
    expect(screen.getByText('Détails techniques')).toBeInTheDocument()
  })
  it('capture d\'échec : image seulement si connecté', () => {
    const result = { error: 'x', failure: { code: 'E-ELM-001' }, failureScreenshot: 'run-screenshots/f.png' }
    const { unmount } = render(<StepFailure result={result} />)
    expect(screen.queryByRole('img')).toBeNull()
    unmount()
    localStorage.setItem('qa-ui-agent-token', 'tok')
    render(<StepFailure result={result} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', expect.stringContaining('/screenshots/f.png?token=tok'))
  })
})

describe('TraceNote', () => {
  it('explique l\'absence de trace quand des secrets sont utilisés', () => {
    render(<TraceNote runResult={{ traceSkipped: 'secrets', status: 'failed' }} />)
    expect(screen.getByText(/identifiants secrets/)).toBeInTheDocument()
  })
  it('rien sans trace', () => {
    const { container } = render(<TraceNote runResult={{ status: 'passed' }} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('lien de téléchargement et commande', () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    render(<TraceNote runResult={{ runId: '77', status: 'failed', tracePath: 'run-traces/77.zip' }} />)
    expect(screen.getByRole('link', { name: /Télécharger la trace/ })).toHaveAttribute('href', expect.stringContaining('/traces/77.zip'))
    expect(screen.getByText('npx playwright show-trace 77.zip')).toBeInTheDocument()
  })
})

const totals = (o) => ({ critical: 0, serious: 0, moderate: 0, minor: 0, total: 0, ...o })
const page = (over = {}) => ({
  url: 'https://a.fr/login', title: 'Connexion', needsReview: 0,
  counts: totals({}), violations: [], ...over,
})

describe('AccessibilityCard', () => {
  it('non activé', () => {
    render(<AccessibilityCard enabled={false} accessibility={null} />)
    expect(screen.getByText('Non activé')).toBeInTheDocument()
  })
  it('activé sans résultat', () => {
    render(<AccessibilityCard enabled accessibility={null} />)
    expect(screen.getByText('En attente')).toBeInTheDocument()
  })
  it('erreur d\'audit', () => {
    render(<AccessibilityCard enabled accessibility={{ status: 'error', error: 'axe KO' }} />)
    expect(screen.getByText('Audit impossible')).toBeInTheDocument()
    expect(screen.getByText('axe KO')).toBeInTheDocument()
  })
  it('aucune page', () => {
    render(<AccessibilityCard enabled accessibility={{ status: 'done', pages: [] }} />)
    expect(screen.getByText('Aucune page auditée')).toBeInTheDocument()
  })
  it('aucun problème', () => {
    render(<AccessibilityCard enabled accessibility={{ status: 'done', pages: [page()], totals: totals({}) }} />)
    expect(screen.getAllByText('Aucun problème détecté').length).toBeGreaterThan(0)
    expect(screen.getByText('/login')).toBeInTheDocument()
  })
  it('problèmes détaillés', () => {
    const violations = [{
      id: 'select-name', impact: 'critical', help: 'Les select doivent avoir un nom', nodesCount: 3,
      description: 'desc', helpUrl: 'https://dequeuniversity.com/x',
      nodes: [{ target: '#civilite', html: '<select>', summary: 'Corrige' }],
    }]
    render(
      <AccessibilityCard
        enabled
        accessibility={{
          status: 'done', partialError: 'timeout',
          pages: [page({ counts: totals({ critical: 1, total: 1 }), violations, needsReview: 2 })],
          totals: totals({ critical: 1, total: 1 }),
        }}
      />,
    )
    expect(screen.getByText('1 problème')).toBeInTheDocument()
    expect(screen.getByText('Les select doivent avoir un nom')).toBeInTheDocument()
    expect(screen.getByText('3 éléments')).toBeInTheDocument()
    expect(screen.getByText(/et 2 autres éléments concernés/)).toBeInTheDocument()
    expect(screen.getByText('#civilite')).toBeInTheDocument()
    expect(screen.getByText(/Une page n'a pas pu être auditée : timeout/)).toBeInTheDocument()
    expect(screen.getByText(/2 points que l'outil/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /select-name/ })).toHaveAttribute('href', 'https://dequeuniversity.com/x')
  })
})
