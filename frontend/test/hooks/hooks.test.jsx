import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNow } from '../../src/hooks/useNow.js'
import { useRunPolling } from '../../src/hooks/useRunPolling.js'
import * as api from '../../src/lib/api.js'

vi.mock('../../src/lib/api.js', () => ({ getRun: vi.fn() }))

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('useNow', () => {
  it('avance chaque seconde tant qu\'il est actif', () => {
    vi.setSystemTime(1000)
    const { result } = renderHook(() => useNow(true))
    expect(result.current).toBe(1000)
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current).toBe(4000)
  })
  it('reste figé quand il est inactif', () => {
    vi.setSystemTime(1000)
    const { result } = renderHook(() => useNow(false))
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current).toBe(1000)
  })
})

describe('useRunPolling', () => {
  it('relit jusqu\'à la fin du run puis s\'arrête', async () => {
    api.getRun
      .mockResolvedValueOnce({ runResult: { status: 'running' } })
      .mockResolvedValueOnce({ runResult: { status: 'passed' } })
    const { result } = renderHook(() => useRunPolling('r1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.data.runResult.status).toBe('running')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(result.current.data.runResult.status).toBe('passed')
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.getRun).toHaveBeenCalledTimes(2)
  })

  it('tolère quelques erreurs puis affiche la dernière', async () => {
    api.getRun.mockRejectedValue(new Error('réseau'))
    const { result } = renderHook(() => useRunPolling('r1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.error).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(result.current.error).toBe('réseau')
    expect(api.getRun).toHaveBeenCalledTimes(5)
  })

  it('se remet à zéro quand l\'id change', async () => {
    api.getRun.mockResolvedValue({ runResult: { status: 'passed' } })
    const { result, rerender } = renderHook(({ id }) => useRunPolling(id), { initialProps: { id: 'a' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.data).not.toBeNull()
    api.getRun.mockReturnValue(new Promise(() => {}))
    rerender({ id: 'b' })
    expect(result.current.data).toBeNull()
  })
})
