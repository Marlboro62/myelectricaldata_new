// « Proposer un nouveau fournisseur » (MED-80, issue #162) : POST /energy/providers est réservé à
// `offers.edit`, un contributeur y recevait un 403 et le message générique « Erreur lors de la
// création du fournisseur ». Un contributeur envoie désormais une contribution NEW_PROVIDER « fournisseur
// seul » (marqueur `[NOUVEAU FOURNISSEUR] <nom>`, sans puissance) ; un modérateur garde la création directe.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'

const droits = vi.hoisted(() => ({ moderateur: false }))

vi.mock('@/api/energy', () => ({
  energyApi: {
    getProviders: vi.fn(),
    getOffers: vi.fn(),
    createProvider: vi.fn(),
    submitContribution: vi.fn(),
    submitContributionBatch: vi.fn(),
  },
}))
vi.mock('@/api/pdl', () => ({ pdlApi: { list: vi.fn(async () => []) } }))
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: () => false, isModerator: () => droits.moderateur, hasPermission: () => false }),
}))
vi.mock('@/stores/notificationStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { energyApi } from '@/api/energy'
import { toast } from '@/stores/notificationStore'
import { useAllOffersState } from '../hooks/useAllOffersState'
import NewProviderForm from '../components/alloffers/NewProviderForm'

const SITE = 'https://www.eniplenitude.fr'
const GRILLE = 'https://example.org/grille.pdf'

// Le formulaire lit l'état en direct : on le monte dans un composant qui porte le hook, et on garde
// la dernière valeur de l'état pour les assertions.
let etat: ReturnType<typeof useAllOffersState>

function Formulaire() {
  etat = useAllOffersState()
  const { setIsAddingProvider } = etat
  useEffect(() => setIsAddingProvider(true), [setIsAddingProvider])
  return <NewProviderForm state={etat} />
}

async function ouvrirLeFormulaire() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <Formulaire />
    </QueryClientProvider>,
  )
  await screen.findByPlaceholderText(/OHM Energie/)
  await waitFor(() => expect(etat.sortedProviders).toHaveLength(1))
}

async function remplir(champs: { nom?: string; site?: string; grille?: string }) {
  const user = userEvent.setup()
  if (champs.nom) await user.type(screen.getByPlaceholderText(/OHM Energie/), champs.nom)
  if (champs.site) await user.type(screen.getByPlaceholderText(/edf\.fr/), champs.site)
  if (champs.grille) await user.type(screen.getByLabelText(/grille|fiche des prix/i), champs.grille)
  return user
}

beforeEach(() => {
  droits.moderateur = false
  vi.mocked(energyApi.getProviders).mockResolvedValue({ success: true, data: [{ id: 'p1', name: 'EDF' }] } as never)
  vi.mocked(energyApi.getOffers).mockResolvedValue({ success: true, data: [] } as never)
  vi.mocked(energyApi.createProvider).mockReset()
  vi.mocked(energyApi.submitContribution).mockReset()
  vi.mocked(energyApi.submitContribution).mockResolvedValue({ success: true, data: { id: 'c1' } } as never)
  vi.mocked(energyApi.submitContributionBatch).mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.error).mockReset()
})

describe('NewProviderForm : contributeur', () => {
  it('demande le lien vers la grille tarifaire', async () => {
    await ouvrirLeFormulaire()

    expect(screen.getByLabelText(/grille|fiche des prix/i)).toBeTruthy()
  })

  it('envoie une contribution NEW_PROVIDER sans puissance, sans appeler createProvider', async () => {
    await ouvrirLeFormulaire()
    const user = await remplir({ nom: 'Plenitude', site: SITE, grille: GRILLE })

    await user.click(screen.getByRole('button', { name: /fournisseur|proposer|soumettre/i }))

    await waitFor(() => expect(energyApi.submitContribution).toHaveBeenCalledTimes(1))
    const envoyee = vi.mocked(energyApi.submitContribution).mock.calls[0][0]
    expect(envoyee).toMatchObject({
      contribution_type: 'NEW_PROVIDER',
      provider_name: 'Plenitude',
      provider_website: SITE,
      offer_name: '[NOUVEAU FOURNISSEUR] Plenitude',
      price_sheet_url: GRILLE,
    })
    expect(envoyee.power_variants).toBeUndefined()
    expect(envoyee.power_kva).toBeUndefined()
    expect(energyApi.createProvider).not.toHaveBeenCalled()
  })

  it('annonce une proposition en attente de validation, pas un fournisseur créé', async () => {
    await ouvrirLeFormulaire()
    const user = await remplir({ nom: 'Plenitude', grille: GRILLE })

    await user.click(screen.getByRole('button', { name: /fournisseur|proposer|soumettre/i }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toMatch(/validation|modérateur|en attente/i)
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).not.toMatch(/créé/i)
    // le fournisseur n'existe pas encore : le formulaire se ferme, aucune sélection d'un id inconnu
    await waitFor(() => expect(etat.isAddingProvider).toBe(false))
  })

  it('ne soumet pas sans lien vers la grille', async () => {
    await ouvrirLeFormulaire()
    await remplir({ nom: 'Plenitude' })

    const bouton = screen.getByRole('button', { name: /fournisseur|proposer|soumettre/i }) as HTMLButtonElement
    expect(bouton.disabled).toBe(true)
    expect(energyApi.submitContribution).not.toHaveBeenCalled()
  })

  it('affiche le message du serveur quand la contribution est refusée (fournisseur déjà présent)', async () => {
    vi.mocked(energyApi.submitContribution).mockResolvedValue({
      success: false, error: { code: 'PROVIDER_EXISTS', message: 'Le fournisseur "Plenitude" existe déjà' },
    } as never)
    await ouvrirLeFormulaire()
    const user = await remplir({ nom: 'Plenitude', grille: GRILLE })

    await user.click(screen.getByRole('button', { name: /fournisseur|proposer|soumettre/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Le fournisseur "Plenitude" existe déjà'))
  })
})

describe('NewProviderForm : modérateur', () => {
  it('garde la création directe et ne demande pas de grille', async () => {
    droits.moderateur = true
    vi.mocked(energyApi.createProvider).mockResolvedValue({ success: true, data: { id: 'p2', name: 'Plenitude' } } as never)
    await ouvrirLeFormulaire()
    expect(screen.queryByLabelText(/grille|fiche des prix/i)).toBeNull()
    const user = await remplir({ nom: 'Plenitude', site: SITE })

    await user.click(screen.getByRole('button', { name: /créer/i }))

    await waitFor(() => expect(energyApi.createProvider).toHaveBeenCalledWith({ name: 'Plenitude', website: SITE }))
    expect(energyApi.submitContribution).not.toHaveBeenCalled()
  })

  it('explique un 403 : droit de modification manquant, proposer plutôt par contribution', async () => {
    // isPrivilegedUser du front peut diverger de `offers.edit` du backend (MED-36)
    droits.moderateur = true
    vi.mocked(energyApi.createProvider).mockRejectedValue({ response: { status: 403, data: { detail: 'Forbidden' } } })
    await ouvrirLeFormulaire()
    const user = await remplir({ nom: 'Plenitude' })

    await user.click(screen.getByRole('button', { name: /créer/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    const message = String(vi.mocked(toast.error).mock.calls[0][0])
    expect(message).toMatch(/droit|autoris|permission/i)
    expect(message).not.toBe('Erreur lors de la création du fournisseur')
  })
})
