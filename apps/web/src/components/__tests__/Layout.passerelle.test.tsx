import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HelmetProvider } from 'react-helmet-async'
import Layout from '../Layout'
import { useAppMode } from '@/hooks/useAppMode'

// Constante injectée par le `define` de vite.config.ts, absente de vitest.config.ts
vi.stubGlobal('__APP_VERSION__', 'test')
// jsdom n'implémente pas scrollTo (appelé au changement de page)
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo

vi.mock('@/hooks/useAppMode', () => ({ useAppMode: vi.fn() }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: '1', email: 'test@example.com' }, logout: vi.fn() }),
}))
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: () => false,
    hasAction: () => false,
    canAccessAdmin: () => false,
    isAdmin: () => false,
    isModerator: () => false,
    isVisitor: () => false,
  }),
}))
vi.mock('@/api/energy', () => ({
  energyApi: {
    getUnreadContributionsCount: vi.fn().mockResolvedValue({ success: true, data: { unread_count: 0 } }),
    getContributionStats: vi.fn().mockResolvedValue({ success: true, data: {} }),
  },
}))
vi.mock('@/api/admin', () => ({
  adminApi: {
    clearAllConsumptionCache: vi.fn(),
    getAllSharedPdls: vi.fn().mockResolvedValue({ success: true, data: [] }),
  },
}))
vi.mock('@/api/pdl', () => ({ pdlApi: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) } }))
vi.mock('@/api/info', () => ({ infoApi: { getInfo: vi.fn().mockResolvedValue({}) } }))

const PASSERELLE_URL = 'https://www.v2.myelectricaldata.fr/dashboard'

const renderLayout = (mode: 'client' | 'server') => {
  vi.mocked(useAppMode).mockReturnValue({
    mode,
    isClientMode: mode === 'client',
    isServerMode: mode === 'server',
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Layout>
            <div>contenu</div>
          </Layout>
        </MemoryRouter>
      </QueryClientProvider>
    </HelmetProvider>
  )
}

/**
 * Lien « Passerelle » (PR #154, MED-59) : lien externe vers le tableau de bord
 * de la passerelle, affiché en mode client uniquement.
 */
describe('Layout : lien Passerelle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mode client : lien externe dans la barre latérale et le menu mobile', () => {
    renderLayout('client')

    // Barre latérale + menu mobile (toujours monté, seulement translaté hors écran)
    const links = screen.getAllByRole('link', { name: /Passerelle/ })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveAttribute('href', PASSERELLE_URL)
      expect(link).toHaveAttribute('target', '_blank')
      // noopener : la passerelle ne doit pas pouvoir piloter l'onglet client
      expect(link.getAttribute('rel')).toContain('noopener')
    }
  })

  it('mode client : le lien Docs Client voisin reste présent', () => {
    renderLayout('client')

    expect(screen.getAllByRole('link', { name: /Docs Client/ })).toHaveLength(2)
  })

  it('mode serveur : aucun lien vers la passerelle', () => {
    renderLayout('server')

    // Contrôle positif : le menu est bien rendu, avec « Docs Serveur » à la place
    expect(screen.getAllByRole('link', { name: /Docs Serveur/ })).toHaveLength(2)
    expect(screen.queryByRole('link', { name: /Passerelle/ })).not.toBeInTheDocument()
    expect(document.querySelector(`a[href="${PASSERELLE_URL}"]`)).toBeNull()
  })
})
