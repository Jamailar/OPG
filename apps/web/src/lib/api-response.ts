export function pickApiData<T>(payload: unknown): T {
  if (payload && typeof payload === 'object') {
    const maybeWrapped = payload as { code?: unknown; data?: unknown };
    if (maybeWrapped.code !== undefined && maybeWrapped.data !== undefined) {
      return maybeWrapped.data as T;
    }
  }
  return payload as T;
}

export function pickApiErrorMessage(error: any, fallback: string): string {
  return error?.response?.data?.detail || error?.response?.data?.message || error?.message || fallback;
}
