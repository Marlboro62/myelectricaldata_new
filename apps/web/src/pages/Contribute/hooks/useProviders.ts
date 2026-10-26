import { useQuery } from '@tanstack/react-query'
import { providersQueryOptions } from '@/api/energyQueries'

/**
 * Hook pour récupérer la liste des fournisseurs d'énergie
 */
export function useProviders() {
  const { data: providers, isLoading, error } = useQuery({
    ...providersQueryOptions(),
  })

  return {
    providers: providers || [],
    isLoading,
    error,
  }
}
