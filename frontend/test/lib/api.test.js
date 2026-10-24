import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getToken, clearToken, login, logout, isLoggedIn, startTestRun, getRuns, getHistory,
  getRun, saveRunNotes, screenshotUrl, traceUrl, downloadRunExport,
} from '../../src/lib/api.js'

function mockFetch(status, body, extra = {}) {
  const fn = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    blob: async () => new Blob(['x']),
    ...extra,
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('connexion', () => {
  it('stocke le token après login et le retire au logout', async () => {
    const fetchMock = mockFetch(200, { token: 'abc' })
    await login('secret')
    expect(getToken()).toBe('abc')
    expect(isLoggedIn()).toBe(true)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/login$/)
    expect(JSON.parse(options.body)).toEqual({ password: 'secret' })
    logout()
    expect(isLoggedIn()).toBe(false)
  })
})

describe('requêtes', () => {
  it('envoie le token en en-tête Authorization', async () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    const fetchMock = mockFetch(200, [])
    await getRuns({ status: 'running' })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/runs\?status=running$/)
    expect(options.headers.Authorization).toBe('Bearer tok')
  })

  it('startTestRun transmet les options, dont checkA11y', async () => {
    const fetchMock = mockFetch(200, { runId: '1' })
    await startTestRun({ url: 'https://a.fr', ticketText: 't', checkA11y: true, browserEngine: 'firefox' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ url: 'https://a.fr', ticketText: 't', checkA11y: true, browserEngine: 'firefox' })
  })

  it('appelle les bonnes routes', async () => {
    const fetchMock = mockFetch(200, {})
    await getHistory()
    await getRun('r 1')
    await saveRunNotes('r1', 'hello')
    const calls = fetchMock.mock.calls
    expect(calls[0][0]).toMatch(/\/api\/history$/)
    expect(calls[1][0]).toMatch(/\/api\/runs\/r 1$/)
    expect(calls[2][1].method).toBe('PATCH')
    expect(JSON.parse(calls[2][1].body)).toEqual({ notes: 'hello' })
  })

  it('renvoie le message du serveur en cas d\'erreur', async () => {
    mockFetch(400, { error: 'URL invalide' })
    await expect(getRuns()).rejects.toThrow('URL invalide')
  })

  it('utilise un message générique si le corps n\'est pas du JSON', async () => {
    mockFetch(500, null)
    await expect(getRuns()).rejects.toThrow('Erreur API (500)')
  })

  it('401 : efface le token et prévient l\'appli', async () => {
    localStorage.setItem('qa-ui-agent-token', 'old')
    mockFetch(401, { error: 'Expiré' })
    const listener = vi.fn()
    window.addEventListener('qa-ui-agent:unauthorized', listener)
    await expect(getRuns()).rejects.toThrow('Expiré')
    expect(getToken()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('qa-ui-agent:unauthorized', listener)
  })
})

describe('URLs de fichiers', () => {
  it('renvoie null sans chemin ou sans token', () => {
    expect(screenshotUrl(null)).toBeNull()
    expect(screenshotUrl('run-screenshots/a.png')).toBeNull()
    expect(traceUrl('run-traces/a.zip')).toBeNull()
  })

  it('ajoute le token dans l\'URL et corrige le préfixe', () => {
    localStorage.setItem('qa-ui-agent-token', 'a b')
    expect(screenshotUrl('run-screenshots/x.png')).toMatch(/\/screenshots\/x\.png\?token=a%20b$/)
    expect(traceUrl('run-traces/1.zip')).toMatch(/\/traces\/1\.zip\?token=a%20b$/)
  })

  it('clearToken retire bien le token', () => {
    localStorage.setItem('qa-ui-agent-token', 't')
    clearToken()
    expect(screenshotUrl('run-screenshots/x.png')).toBeNull()
  })
})

describe('downloadRunExport', () => {
  it('refuse un format inconnu', async () => {
    await expect(downloadRunExport('1', 'csv')).rejects.toThrow('Format d\'export inconnu')
  })

  it('télécharge le fichier avec le bon nom', async () => {
    localStorage.setItem('qa-ui-agent-token', 'tok')
    mockFetch(200, null)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await downloadRunExport('42', 'junit')
    expect(click).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
    click.mockRestore()
  })

  it('401 et erreur serveur', async () => {
    mockFetch(401, null)
    await expect(downloadRunExport('1', 'json')).rejects.toThrow('Authentification requise')
    mockFetch(404, { error: 'Run introuvable' })
    await expect(downloadRunExport('1', 'json')).rejects.toThrow('Run introuvable')
  })
})
