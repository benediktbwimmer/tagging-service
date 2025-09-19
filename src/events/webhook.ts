import { getConfig } from '../config';
import { logger } from '../lib/logger';
import { httpRequest } from '../utils/http';

export class WebhookNotifier {
  private readonly url?: string;

  constructor() {
    const { WEBHOOK_URL } = getConfig();
    this.url = WEBHOOK_URL || undefined;
  }

  async emit(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.url) {
      return;
    }
    try {
      await httpRequest(this.url, {
        method: 'POST',
        body: JSON.stringify({ event, payload, emittedAt: new Date().toISOString() }),
        headers: { 'Content-Type': 'application/json' },
        retry: 1
      });
    } catch (error) {
      logger.warn({ event, err: error }, 'Failed to deliver webhook notification');
    }
  }
}
