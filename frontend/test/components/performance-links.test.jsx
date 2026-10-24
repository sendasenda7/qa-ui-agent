import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PerformanceCard from '../../src/components/PerformanceCard.jsx'
import LinksCard from '../../src/components/LinksCard.jsx'

const perfPage = (over = {}) => ({
  url: 'https://a.fr/login',
  title: 'Connexion',
  notMeasured: false,
  metrics: { ttfbMs: 200, fcpMs: 900, lcpMs: 1200, cls: 0.01, loadMs: 1500, requests: 20, transferBytes: 512 * 1024, domContentLoadedMs: 900 },
  ratings: { ttfb: 'good', fcp: 'good', lcp: 'good', cls: 'good' },
  issues: [],
  slowest: [],
  ...over,
})
const perfTotals = (o) => ({ pages: 1, measured: 1, issues: 0, high: 0, medium: 0, low: 0, ...o })

describe('PerformanceCard', () => {
  it('non activé, en attente, erreur, aucune page', () => {
    const { rerender } = render(<PerformanceCard enabled={false} performance={null} />)
    expect(screen.getByText('Non activé')).toBeInTheDocument()
    rerender(<PerformanceCard enabled performance={null} />)
    expect(screen.getByText('En attente')).toBeInTheDocument()
    rerender(<PerformanceCard enabled performance={{ status: 'error', error: 'page fermée' }} />)
    expect(screen.getByText('page fermée')).toBeInTheDocument()
    rerender(<PerformanceCard enabled performance={{ status: 'empty', pages: [] }} />)
    expect(screen.getByText('Aucune page mesurée')).toBeInTheDocument()
  })
  it('page rapide : valeurs, notes et poids', () => {
    render(<PerformanceCard enabled performance={{ status: 'done', pages: [perfPage()], totals: perfTotals({}) }} />)
    expect(screen.getByText('Aucun point faible')).toBeInTheDocument()
    expect(screen.getByText('1,20 s')).toBeInTheDocument() // LCP
    expect(screen.getAllByText('Bon').length).toBe(4)
    expect(screen.getByText(/20 requêtes · 512 Ko transférés/)).toBeInTheDocument()
    expect(screen.getByText('/login')).toBeInTheDocument()
  })
  it('points faibles, LCP non mesuré (Firefox) et ressources lentes', () => {
    const page = perfPage({
      metrics: { ttfbMs: 2000, fcpMs: 900, lcpMs: null, cls: 0.4, loadMs: null, requests: 1, transferBytes: 0, domContentLoadedMs: null },
      ratings: { ttfb: 'poor', fcp: 'good', lcp: null, cls: 'poor' },
      issues: [{ code: 'P-TTFB', severity: 'high', message: 'TTFB trop long.' }, { code: 'P-WEIGHT', severity: 'medium', message: 'Page lourde.' }],
      slowest: [{ url: 'a.fr/app.js', durationMs: 1800 }],
    })
    render(<PerformanceCard enabled performance={{ status: 'done', partialError: 'timeout', pages: [page], totals: perfTotals({ issues: 2, high: 1, medium: 1 }) }} />)
    expect(screen.getByText('2 points faibles')).toBeInTheDocument()
    expect(screen.getByText('non mesuré')).toBeInTheDocument()
    expect(screen.getAllByText('Mauvais').length).toBe(2)
    expect(screen.getByText('Important')).toBeInTheDocument()
    expect(screen.getByText('P-TTFB')).toBeInTheDocument()
    expect(screen.getByText('a.fr/app.js')).toBeInTheDocument()
    expect(screen.getByText('1,80 s')).toBeInTheDocument()
    expect(screen.getByText(/Une page n'a pas pu être mesurée : timeout/)).toBeInTheDocument()
  })
  it('page atteinte sans rechargement : non notée', () => {
    render(<PerformanceCard enabled performance={{ status: 'done', pages: [perfPage({ notMeasured: true })], totals: perfTotals({ measured: 0 }) }} />)
    expect(screen.getByText(/Page atteinte sans rechargement/)).toBeInTheDocument()
    expect(screen.queryByText('Bon')).toBeNull()
  })
})

const linkPage = (over = {}) => ({
  url: 'https://a.fr/login', title: 'Connexion', total: 12, checked: 12, skipped: 0,
  broken: [], brokenCount: 0, restricted: [], restrictedCount: 0, uncheckedCount: 0, uncheckedReasons: [],
  brokenAnchors: [], brokenImages: [], ...over,
})
const linkTotals = (o) => ({ pages: 1, checked: 12, broken: 0, restricted: 0, unchecked: 0, brokenAnchors: 0, brokenImages: 0, issues: 0, ...o })

describe('LinksCard', () => {
  it('non activé, en attente, erreur, aucune page', () => {
    const { rerender } = render(<LinksCard enabled={false} links={null} />)
    expect(screen.getByText('Non activé')).toBeInTheDocument()
    rerender(<LinksCard enabled links={null} />)
    expect(screen.getByText('En attente')).toBeInTheDocument()
    rerender(<LinksCard enabled links={{ status: 'error', error: 'page fermée' }} />)
    expect(screen.getByText('page fermée')).toBeInTheDocument()
    rerender(<LinksCard enabled links={{ status: 'empty', pages: [] }} />)
    expect(screen.getByText('Aucune page contrôlée')).toBeInTheDocument()
  })
  it('aucun lien cassé', () => {
    render(<LinksCard enabled links={{ status: 'done', pages: [linkPage()], totals: linkTotals({}) }} />)
    expect(screen.getByText('Aucun lien cassé')).toBeInTheDocument()
    expect(screen.getByText(/12 liens vérifiés sur 12 trouvés/)).toBeInTheDocument()
    expect(screen.getByText(/Aucun lien, ancre ni image cassé/)).toBeInTheDocument()
  })
  it('liens, ancres et images cassés avec détails ; protégés et non vérifiés comptés', () => {
    const page = linkPage({
      broken: [{ href: 'https://a.fr/gone', text: 'Ancien tarif', status: 404, external: false }, { href: 'https://ext.com/', text: '', detail: 'nom de domaine introuvable', external: true }],
      brokenCount: 3,
      restrictedCount: 2,
      uncheckedCount: 1,
      skipped: 4,
      uncheckedReasons: ['adresse locale ou privée refusée'],
      brokenAnchors: [{ href: '#tarifs', text: 'Nos tarifs' }],
      brokenImages: [{ src: 'https://a.fr/logo.png', alt: 'Logo' }],
    })
    render(<LinksCard enabled links={{ status: 'done', pages: [page], totals: linkTotals({ broken: 3, brokenAnchors: 1, brokenImages: 1, issues: 5 }) }} />)
    expect(screen.getByText('5 problèmes')).toBeInTheDocument()
    expect(screen.getByText('404')).toBeInTheDocument()
    expect(screen.getByText('https://a.fr/gone')).toBeInTheDocument()
    expect(screen.getByText(/Ancien tarif/)).toBeInTheDocument()
    expect(screen.getByText(/nom de domaine introuvable · lien externe/)).toBeInTheDocument()
    expect(screen.getByText(/Liens cassés \(3, 2 affichés\)/)).toBeInTheDocument()
    expect(screen.getByText('#tarifs')).toBeInTheDocument()
    expect(screen.getByText('https://a.fr/logo.png')).toBeInTheDocument()
    expect(screen.getByText(/2 protégés \(connexion requise\)/)).toBeInTheDocument()
    expect(screen.getByText(/5 non vérifiés/)).toBeInTheDocument()
    expect(screen.getByText(/adresse locale ou privée refusée/)).toBeInTheDocument()
  })
})
