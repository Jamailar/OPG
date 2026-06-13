import useSWR from 'swr';
import { authApi } from '@/lib/api';
import { authService } from '@/lib/auth-service';
import { runtimeContext } from '@/lib/runtime-context';

const swrConfig = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  dedupingInterval: 60000,
};

export function useCurrentUser() {
  const token = authService.getToken();
  const key = token ? ['currentUser', runtimeContext.portalMode, runtimeContext.appSlug, token] : null;

  return useSWR(key, () => authApi.getCurrentUser(), {
    ...swrConfig,
    revalidateOnMount: true,
  });
}
