import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PhaseTimeline from '../../src/components/PhaseTimeline.jsx'
import RunStepList from '../../src/components/RunStepList.jsx'

describe('PhaseTimeline', () => {
  it('3 phases sans analyse', () => {
    render(<PhaseTimeline run={{ phase: 'planning', status: 'running', crawl: { elementCount: 9 } }} options={{}} />)
    expect(screen.getByText('Exploration de la page')).toBeInTheDocument()
    expect(screen.queryByText(/Analyse RTL/)).toBeNull()
    expect(screen.getByText('9 éléments interactifs détectés')).toBeInTheDocument()
    expect(screen.getByText('Analyse du ticket et des éléments détectés')).toBeInTheDocument()
  })
  it('phase d\'analyse nommée quand activée', () => {
    render(<PhaseTimeline run={{ phase: 'running', status: 'running', crawl: { elementCount: 3 }, stepsTotal: 4, stepsRun: 1 }} options={{ checkRtl: true, checkVisualDiff: true }} />)
    expect(screen.getByText(/En attente de la fin du scénario \(vérification RTL FR\/AR \+ diff visuel\)/)).toBeInTheDocument()
    expect(screen.getByText('1 sur 4 étapes terminées')).toBeInTheDocument()
  })
  it('page vide : échec de l\'exploration', () => {
    render(<PhaseTimeline run={{ status: 'error', crawl: { elementCount: 0 }, failure: { category: 'CRAWL_EMPTY' } }} options={{}} />)
    expect(screen.getByText('Aucun élément détecté sur la page')).toBeInTheDocument()
  })
  it('run terminé : tout est fait', () => {
    render(<PhaseTimeline run={{ phase: 'done', status: 'passed', crawl: { elementCount: 2 }, stepsTotal: 2, stepsRun: 2 }} options={{}} />)
    expect(screen.getByText('2 étapes prévues')).toBeInTheDocument()
    expect(screen.getByText('2 sur 2 étapes terminées')).toBeInTheDocument()
  })
})

describe('RunStepList', () => {
  it('rien sans étape', () => {
    const { container } = render(<RunStepList steps={[]} results={[]} currentIndex={0} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('affiche les étapes dans leurs états', () => {
    const steps = [{ description: 'Ouvrir' }, { description: 'Cliquer' }, { description: 'Vérifier' }]
    const results = [{ status: 'passed' }, { status: 'failed', error: 'Introuvable' }]
    render(<RunStepList steps={steps} results={results} currentIndex={2} />)
    expect(screen.getByText("Étapes d'exécution")).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('Introuvable')).toBeInTheDocument()
  })
})
