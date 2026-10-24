import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StatusBadge from '../../src/components/StatusBadge.jsx'
import StatCard from '../../src/components/StatCard.jsx'
import ProgressBar from '../../src/components/ProgressBar.jsx'
import Toggle from '../../src/components/Toggle.jsx'
import AttemptsNote from '../../src/components/AttemptsNote.jsx'
import FlakyNotice from '../../src/components/FlakyNotice.jsx'
import RunError from '../../src/components/RunError.jsx'
import AnalysisCard from '../../src/components/AnalysisCard.jsx'
import RunListItem from '../../src/components/RunListItem.jsx'

describe('StatusBadge', () => {
  it.each([
    ['passed', 'Réussi'], ['failed', 'Échoué'], ['warning', 'Avertissement'],
    ['running', 'En cours'], ['error', 'Erreur'], ['autre', 'autre'],
  ])('%s -> %s', (status, label) => {
    render(<StatusBadge status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

describe('StatCard', () => {
  it('affiche libellé, valeur et sous-libellé', () => {
    render(<StatCard label="Runs" value={12} sublabel="détail" tone="success" />)
    expect(screen.getByText('Runs')).toBeInTheDocument()
    expect(screen.getByText('12')).toHaveClass('text-success')
    expect(screen.getByText('détail')).toBeInTheDocument()
  })
  it('sans sous-libellé', () => {
    render(<StatCard label="A" value="B" />)
    expect(screen.queryByText('détail')).toBeNull()
  })
})

describe('ProgressBar', () => {
  it('borne la largeur entre 0 et 100 %', () => {
    const { container, rerender } = render(<ProgressBar percent={150} />)
    expect(container.firstChild.firstChild).toHaveStyle({ width: '100%' })
    rerender(<ProgressBar percent={-5} tone="danger" />)
    expect(container.firstChild.firstChild).toHaveStyle({ width: '0%' })
    rerender(<ProgressBar percent={40} tone="success" />)
    expect(container.firstChild.firstChild).toHaveStyle({ width: '40%' })
  })
})

describe('Toggle', () => {
  it('expose son état et bascule au clic', async () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })
  it('coché -> décoche', async () => {
    const onChange = vi.fn()
    render(<Toggle checked onChange={onChange} />)
    await userEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(false)
  })
})

describe('AttemptsNote', () => {
  it('rien au premier essai ou sans résultat', () => {
    const { container, rerender } = render(<AttemptsNote result={{ attempts: 1, status: 'passed' }} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<AttemptsNote result={undefined} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<AttemptsNote result={{ status: 'passed' }} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('étape instable : réussie au 2e essai avec le premier échec', () => {
    render(<AttemptsNote result={{ attempts: 2, status: 'passed', firstFailure: { code: 'E-ELM-001', message: 'introuvable' } }} />)
    expect(screen.getByText(/Instable : réussi au 2e essai/)).toBeInTheDocument()
    expect(screen.getByText('E-ELM-001')).toBeInTheDocument()
  })
  it('échec confirmé', () => {
    render(<AttemptsNote result={{ attempts: 3, status: 'failed' }} />)
    expect(screen.getByText('Échec confirmé après 3 essais')).toBeInTheDocument()
  })
})

describe('FlakyNotice', () => {
  it('rien sans étape instable', () => {
    const { container } = render(<FlakyNotice runResult={{ flakySteps: 0 }} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('accorde au singulier et au pluriel', () => {
    const { rerender } = render(<FlakyNotice runResult={{ flakySteps: 1 }} />)
    expect(screen.getByText(/1 étape n'a réussi/)).toBeInTheDocument()
    rerender(<FlakyNotice runResult={{ flakySteps: 3 }} />)
    expect(screen.getByText(/3 étapes n'ont réussi/)).toBeInTheDocument()
  })
})

describe('RunError', () => {
  it('rien sans erreur', () => {
    const { container } = render(<RunError runResult={{}} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('ancien run : texte simple', () => {
    render(<RunError runResult={{ error: 'Boom' }} />)
    expect(screen.getByText('Boom')).toBeInTheDocument()
  })
  it('run récent : détail structuré', () => {
    render(<RunError runResult={{ error: 'Page vide', failure: { code: 'E-CRW-001', hint: 'Vérifie l\'URL' } }} />)
    expect(screen.getByText('E-CRW-001')).toBeInTheDocument()
    expect(screen.getByText('Vérifie l\'URL')).toBeInTheDocument()
  })
})

describe('AnalysisCard', () => {
  it('affiche titre, badge et contenu', () => {
    render(<AnalysisCard title="T" badge="OK" tone="success"><p>contenu</p></AnalysisCard>)
    expect(screen.getByText('T')).toBeInTheDocument()
    expect(screen.getByText('OK')).toHaveClass('text-success')
    expect(screen.getByText('contenu')).toBeInTheDocument()
  })
  it('sans badge', () => {
    render(<AnalysisCard title="T">x</AnalysisCard>)
    expect(screen.queryByText('OK')).toBeNull()
  })
})

describe('RunListItem', () => {
  const base = { ticketSummary: 'Login', url: 'https://a.fr', status: 'running' }
  it.each([
    [{ phase: 'crawling' }, 'Exploration de la page…'],
    [{ phase: 'planning' }, 'Génération du scénario…'],
    [{ phase: 'running' }, 'Exécution…'],
    [{ phase: 'x' }, 'Démarrage…'],
    [{ stepsTotal: 5, stepsRun: 2 }, '2/5 étapes'],
    [{ status: 'passed', stepsTotal: 5, stepsPassed: 5 }, '5/5 étapes'],
    [{ status: 'error' }, 'Aucune étape exécutée'],
  ])('progression %o', (extra, label) => {
    render(<RunListItem run={{ ...base, ...extra }} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('Login')).toBeInTheDocument()
  })
})
