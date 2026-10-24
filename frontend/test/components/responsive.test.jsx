import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ResponsiveCard from '../../src/components/ResponsiveCard.jsx'

const totals = (o) => ({ pages: 1, issues: 0, high: 0, medium: 0, low: 0, viewportsWithIssues: 0, viewportsChecked: 3, ...o })
const viewport = (name, label, width, over = {}) => ({ name, label, width, height: 800, issues: [], ...over })
const page = (viewports) => ({ url: 'https://a.fr/login', title: 'Connexion', viewports })
const cleanPage = () => page([viewport('mobile', 'Mobile', 375), viewport('tablet', 'Tablette', 768), viewport('desktop', 'Bureau', 1440)])

describe('ResponsiveCard', () => {
  it('non activé', () => {
    render(<ResponsiveCard enabled={false} responsive={null} />)
    expect(screen.getByText('Non activé')).toBeInTheDocument()
  })
  it('activé sans résultat', () => {
    render(<ResponsiveCard enabled responsive={null} />)
    expect(screen.getByText('En attente')).toBeInTheDocument()
  })
  it('contrôle impossible', () => {
    render(<ResponsiveCard enabled responsive={{ status: 'error', error: 'page fermée' }} />)
    expect(screen.getByText('Contrôle impossible')).toBeInTheDocument()
    expect(screen.getByText('page fermée')).toBeInTheDocument()
  })
  it('aucune page', () => {
    render(<ResponsiveCard enabled responsive={{ status: 'empty', pages: [] }} />)
    expect(screen.getByText('Aucune page contrôlée')).toBeInTheDocument()
  })
  it('aucun défaut : un message par taille d\'écran', () => {
    render(<ResponsiveCard enabled responsive={{ status: 'done', pages: [cleanPage()], totals: totals({}) }} />)
    expect(screen.getAllByText('Aucun défaut détecté').length).toBe(4) // badge + 3 tailles
    expect(screen.getByText('/login')).toBeInTheDocument()
    expect(screen.getByText('Tablette')).toBeInTheDocument()
  })
  it('défauts détaillés, capture seulement si connecté, taille en erreur signalée', () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    const issue = { code: 'R-OVERFLOW', severity: 'high', message: 'La page défile horizontalement.', count: 1, examples: ['table.prix (dépasse jusqu\'à 620 px)'] }
    const withIssue = page([
      viewport('mobile', 'Mobile', 375, { issues: [issue], screenshot: 'run-screenshots/1-responsive-p0-mobile.png' }),
      viewport('tablet', 'Tablette', 768, { error: 'mesure impossible' }),
      viewport('desktop', 'Bureau', 1440),
    ])
    render(
      <ResponsiveCard
        enabled
        responsive={{ status: 'done', partialError: 'timeout', pages: [withIssue], totals: totals({ issues: 1, high: 1, viewportsWithIssues: 1 }) }}
      />,
    )
    expect(screen.getByText('1 défaut')).toBeInTheDocument()
    expect(screen.getByText('Important')).toBeInTheDocument()
    expect(screen.getByText('R-OVERFLOW')).toBeInTheDocument()
    expect(screen.getByText('La page défile horizontalement.')).toBeInTheDocument()
    expect(screen.getByText(/table\.prix/)).toBeInTheDocument()
    expect(screen.getByText(/Contrôle impossible : mesure impossible/)).toBeInTheDocument()
    expect(screen.getByText(/Une page n'a pas pu être contrôlée : timeout/)).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', expect.stringContaining('/screenshots/1-responsive-p0-mobile.png?token=tok'))
  })
  it('pluriel du badge et gravité moyenne', () => {
    const issue = (code, severity) => ({ code, severity, message: code, count: 1, examples: [] })
    const p = page([viewport('mobile', 'Mobile', 375, { issues: [issue('R-SMALL-TARGET', 'medium'), issue('R-NO-VIEWPORT-META', 'low')] })])
    render(<ResponsiveCard enabled responsive={{ status: 'done', pages: [p], totals: totals({ issues: 2, medium: 1, low: 1 }) }} />)
    expect(screen.getByText('2 défauts')).toBeInTheDocument()
    expect(screen.getByText('Moyen')).toBeInTheDocument()
    expect(screen.getByText('Faible')).toBeInTheDocument()
  })
})
