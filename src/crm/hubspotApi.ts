const BASE = 'https://api.hubapi.com';

export class HubspotError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    what: string,
  ) {
    super(`HubSpot ${what}: HTTP ${status} ${detail}`.trim());
  }
}

/** Cliente HTTP mínimo de HubSpot con token de Private App. El token nunca se incluye en los errores. */
export class HubspotApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* respuesta no JSON */
    }
    if (!res.ok) {
      const message = (json as { message?: string } | undefined)?.message ?? text.slice(0, 200);
      throw new HubspotError(res.status, message, `${method} ${path}`);
    }
    return json as T;
  }
}
