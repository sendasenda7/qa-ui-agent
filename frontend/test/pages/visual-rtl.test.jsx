import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VisualRtl from '../../src/pages/VisualRtl.jsx'
import * as api from '../../src/lib/api.js'

vi.mock('../../src/lib/api.js', () => ({
  checkI18n: vi.fn(), compareRuns: vi.fn(), getRuns: vi.fn(),
  screenshotUrl: (p) => (p ? `http://api/${p}` : null),
}))

beforeEach(() => vi.clearAllMocks())

describe('Visual/RTL : onglet FR/AR + RTL', () => {
  const report = (over = {}) => ({ frDir: 'ltr', arDir: 'rtl', elementsComparedCount: 14, findingsCount: 0, findings: [], ...over })

  it('vérifie l\'URL saisie et montre un résultat sans problème', async () => {
    api.checkI18n.mockResolvedValue(report())
    render(<VisualRtl />)
    const input = screen.getByDisplayValue(/staging.helpify.tn/)
    fireEvent.change(input, { target: { value: 'https://exemple.fr' } })
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier FR/AR + RTL' }))
    expect(api.checkI18n).toHaveBeenCalledWith({ url: 'https://exemple.fr' })
    expect(await screen.findByText('RTL appliqué')).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()
    expect(screen.getByText('Aucun problème détecté.')).toBeInTheDocument()
  })

  it('RTL non appliqué et anomalies détaillées par gravité', async () => {
    api.checkI18n.mockResolvedValue(report({
      arDir: 'ltr', findingsCount: 2,
      findings: [
        { severity: 'high', type: 'direction', description: 'Le document reste en LTR', selector: 'html' },
        { severity: 'medium', type: 'untranslated', description: 'Texte non traduit' },
      ],
    }))
    render(<VisualRtl />)
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier FR/AR + RTL' }))
    expect(await screen.findByText('RTL non appliqué')).toBeInTheDocument()
    expect(screen.getByText('HIGH')).toBeInTheDocument()
    expect(screen.getByText('MEDIUM')).toBeInTheDocument()
    expect(screen.getByText('Le document reste en LTR')).toBeInTheDocument()
    expect(screen.getByText('html')).toBeInTheDocument()
    expect(screen.getByText('2 problème(s) détecté(s)')).toBeInTheDocument()
  })

  it('erreur du serveur', async () => {
    api.checkI18n.mockRejectedValue(new Error('Aucun bouton de langue'))
    render(<VisualRtl />)
    await userEvent.click(screen.getByRole('button', { name: 'Vérifier FR/AR + RTL' }))
    expect(await screen.findByText('Aucun bouton de langue')).toBeInTheDocument()
  })

  it('bouton désactivé sans URL', async () => {
    render(<VisualRtl />)
    await userEvent.clear(screen.getByDisplayValue(/staging.helpify.tn/))
    expect(screen.getByRole('button', { name: 'Vérifier FR/AR + RTL' })).toBeDisabled()
  })
})

describe('Visual/RTL : onglet diff visuel', () => {
  const runs = [
    { runId: 1, ticketSummary: 'Connexion' },
    { runId: 2, ticketSummary: 'Connexion' },
  ]
  const compare = (over = {}) => ({
    warnings: [], maxDiffPercent: 12.5, hasRegressions: true, regressionCount: 1, stepCount: 3,
    steps: [
      { index: 0, description: 'Ouvrir', comparable: true, isRegression: true, diffPercent: 12.5, screenshotA: 'run-screenshots/1-0.png', screenshotB: 'run-screenshots/2-0.png', diffImagePath: 'diff-screenshots/d.png' },
      { index: 1, description: 'Cliquer', comparable: true, isRegression: false, diffPercent: 0, screenshotA: 'a.png', screenshotB: 'b.png', diffImagePath: null },
      { index: 2, description: 'Vérifier', comparable: false, reason: 'Capture manquante' },
    ],
    ...over,
  })
  async function openDiffTab() {
    render(<VisualRtl />)
    await userEvent.click(screen.getByRole('button', { name: 'Diff visuel' }))
  }

  it('moins de deux runs : explication', async () => {
    api.getRuns.mockResolvedValue([runs[0]])
    await openDiffTab()
    expect(await screen.findByText(/Il faut au moins deux runs/)).toBeInTheDocument()
  })

  it('compare deux runs et alterne côte à côte / diff', async () => {
    api.getRuns.mockResolvedValue(runs)
    api.compareRuns.mockResolvedValue(compare({ warnings: ['Nombre d\'étapes différent'] }))
    await openDiffTab()
    const [selectA, selectB] = await screen.findAllByRole('combobox')
    const button = screen.getByRole('button', { name: 'Comparer' })
    expect(button).toBeDisabled()
    await userEvent.selectOptions(selectA, '1')
    await userEvent.selectOptions(selectB, '2')
    await userEvent.click(button)
    expect(api.compareRuns).toHaveBeenCalledWith({ runIdA: '1', runIdB: '2' })

    expect(await screen.findByText('12.5%', { selector: 'span.text-2xl' })).toBeInTheDocument()
    expect(screen.getByText(/Nombre d'étapes différent/)).toBeInTheDocument()
    expect(screen.getByText('1/3 étape(s) avec régression')).toBeInTheDocument()
    expect(screen.getByText('Capture manquante')).toBeInTheDocument()
    expect(screen.getByText('non comparable')).toBeInTheDocument()
    expect(screen.getAllByText('Référence (A)')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'Ouvrir — actuel' })).toHaveClass('border-danger')

    await userEvent.click(screen.getByRole('button', { name: 'Diff (overlay)' }))
    expect(screen.queryByText('Référence (A)')).toBeNull()
    expect(screen.getByRole('img', { name: 'Ouvrir — diff pixel' })).toHaveAttribute('src', 'http://api/diff-screenshots/d.png')
    expect(screen.queryByRole('img', { name: 'Cliquer — diff pixel' })).toBeNull()
  })

  it('aucune étape comparable : écart affiché par un tiret', async () => {
    api.getRuns.mockResolvedValue(runs)
    api.compareRuns.mockResolvedValue(compare({ maxDiffPercent: null, hasRegressions: false, regressionCount: 0, steps: [], warnings: undefined }))
    await openDiffTab()
    const [selectA, selectB] = await screen.findAllByRole('combobox')
    await userEvent.selectOptions(selectA, '1')
    await userEvent.selectOptions(selectB, '2')
    await userEvent.click(screen.getByRole('button', { name: 'Comparer' }))
    expect(await screen.findByText('—')).toBeInTheDocument()
  })

  it('erreur de chargement des runs et de comparaison', async () => {
    api.getRuns.mockRejectedValue(new Error('Serveur KO'))
    await openDiffTab()
    expect(await screen.findByText('Serveur KO')).toBeInTheDocument()
  })

  it('erreur de comparaison', async () => {
    api.getRuns.mockResolvedValue(runs)
    api.compareRuns.mockRejectedValue(new Error('Run introuvable'))
    await openDiffTab()
    const [selectA, selectB] = await screen.findAllByRole('combobox')
    await userEvent.selectOptions(selectA, '1')
    await userEvent.selectOptions(selectB, '2')
    await userEvent.click(screen.getByRole('button', { name: 'Comparer' }))
    expect(await screen.findByText('Run introuvable')).toBeInTheDocument()
  })
})
