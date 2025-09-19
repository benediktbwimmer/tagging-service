import { getConfig } from '../config';
import { httpRequest } from '../utils/http';
import { RepositoryMetadata, TagPayload } from '../jobs/types';

interface CatalogTagRequest {
  tags: Array<TagPayload & { source?: string }>;
  remove?: Array<{ key: string; value: string }>;
}

export class CatalogClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor() {
    const { CATALOG_BASE_URL, CATALOG_TOKEN } = getConfig();
    this.baseUrl = CATALOG_BASE_URL.replace(/\/$/, '');
    this.token = CATALOG_TOKEN;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`
    };
  }

  async getRepository(repositoryId: string): Promise<RepositoryMetadata> {
    const url = `${this.baseUrl}/apps/${repositoryId}`;
    return httpRequest<RepositoryMetadata>(url, {
      headers: this.authHeaders()
    });
  }

  async postTags(repositoryId: string, payload: CatalogTagRequest): Promise<void> {
    const url = `${this.baseUrl}/apps/${repositoryId}/tags`;
    await httpRequest(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: this.authHeaders()
    });
  }

  async listRepositories(params: { page?: number; perPage?: number } = {}): Promise<RepositoryMetadata[]> {
    const { page = 1, perPage = 50 } = params;
    const url = `${this.baseUrl}/apps?page=${page}&perPage=${perPage}`;
    return httpRequest<RepositoryMetadata[]>(url, {
      headers: this.authHeaders()
    });
  }
}
