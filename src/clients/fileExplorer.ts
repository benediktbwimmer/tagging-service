import { getConfig } from '../config';
import { httpRequest } from '../utils/http';
import { FileTagPayload, TagPayload } from '../jobs/types';

export interface FileExplorerSearchResult {
  path: string;
  score?: number;
  preview?: string;
}

export class FileExplorerClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor() {
    const { FILE_EXPLORER_BASE_URL, FILE_EXPLORER_TOKEN } = getConfig();
    this.baseUrl = FILE_EXPLORER_BASE_URL.replace(/\/$/, '');
    this.token = FILE_EXPLORER_TOKEN || undefined;
  }

  private headers(): Record<string, string> {
    if (!this.token) {
      return {};
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  async searchFiles(repositoryId: string, limit = 50): Promise<FileExplorerSearchResult[]> {
    const url = `${this.baseUrl}/api/search?repositoryId=${encodeURIComponent(repositoryId)}&limit=${limit}`;
    return httpRequest<FileExplorerSearchResult[]>(url, { headers: this.headers(), retry: 1 });
  }

  async applyFileTags(repositoryId: string, payload: FileTagPayload): Promise<void> {
    const url = `${this.baseUrl}/api/tags`;
    await httpRequest(url, {
      method: 'POST',
      body: JSON.stringify({ repositoryId, path: payload.path, tags: payload.tags }),
      headers: this.headers()
    });
  }

  async removeFileTags(repositoryId: string, payload: { path: string; tags: TagPayload[] }): Promise<void> {
    const url = `${this.baseUrl}/api/tags`;
    await httpRequest(url, {
      method: 'DELETE',
      body: JSON.stringify({ repositoryId, path: payload.path, tags: payload.tags }),
      headers: this.headers()
    });
  }
}
