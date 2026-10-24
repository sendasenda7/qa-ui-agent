import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TraceNote from '../../src/components/TraceNote.jsx'

describe('TraceNote : copie de la commande', () => {
  const run = { runId: '77', status: 'failed', tracePath: 'run-traces/77.zip' }

  it('copie la commande dans le presse-papiers et confirme', async () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    const user = userEvent.setup()
    render(<TraceNote runResult={run} />)
    await user.click(screen.getByRole('button', { name: 'Copier la commande' }))
    expect(await navigator.clipboard.readText()).toBe('npx playwright show-trace 77.zip')
  })

  it('presse-papiers indisponible : aucune erreur, la commande reste affichée', async () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    const user = userEvent.setup()
    render(<TraceNote runResult={run} />)
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('non sécurisé'))
    await user.click(screen.getByRole('button', { name: 'Copier la commande' }))
    expect(screen.getByText('npx playwright show-trace 77.zip')).toBeInTheDocument()
  })
})
