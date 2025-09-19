export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public responseBody: string,
    public url: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpRequestOptions extends RequestInit {
  retry?: number;
  retryDelayMs?: number;
}

export async function httpRequest<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const { retry = 0, retryDelayMs = 250, ...fetchOptions } = options;

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retry) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'tagging-service/0.1',
          ...(fetchOptions.headers ?? {})
        }
      });

      if (!response.ok) {
        const body = await response.text();
        throw new HttpError(
          `Request to ${url} failed with status ${response.status}`,
          response.status,
          response.statusText,
          body,
          url
        );
      }

      const text = await response.text();
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt > retry) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }

  throw lastError;
}
