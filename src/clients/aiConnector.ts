import { getConfig } from '../config';
import { httpRequest } from '../utils/http';
import { AiTaggingResponse, TaggingJobMetrics } from '../jobs/types';
import { PermanentJobError, TransientJobError } from '../jobs/errors';

interface AiCompletionChoice {
  message: { role: string; content: string };
  finish_reason?: string;
}

interface AiCompletionResponse {
  id: string;
  model: string;
  choices: AiCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class AiConnectorClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    const { AI_CONNECTOR_BASE_URL, AI_CONNECTOR_MODEL } = getConfig();
    this.baseUrl = AI_CONNECTOR_BASE_URL.replace(/\/$/, '');
    this.model = AI_CONNECTOR_MODEL;
  }

  private responseFormatSchema() {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'tagging_response',
        schema: {
          type: 'object',
          properties: {
            repository_tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                  confidence: { type: 'number', minimum: 0, maximum: 1 }
                },
                required: ['key', 'value']
              }
            },
            file_tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  tags: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        key: { type: 'string' },
                        value: { type: 'string' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 }
                      },
                      required: ['key', 'value']
                    }
                  }
                },
                required: ['path', 'tags']
              }
            }
          },
          required: ['repository_tags']
        }
      }
    } as const;
  }

  async generateTags(prompt: string): Promise<{ response: AiTaggingResponse; metrics: TaggingJobMetrics }> {
    const url = `${this.baseUrl}/chat/completions`;
    let apiResponse: AiCompletionResponse;
    try {
      apiResponse = await httpRequest<AiCompletionResponse>(url, {
        method: 'POST',
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: this.responseFormatSchema(),
          messages: [
            {
              role: 'system',
              content: 'You are an assistant that produces repository and file tags in JSON. Be accurate and concise.'
            },
            { role: 'user', content: prompt }
          ]
        }),
        retry: 2,
        retryDelayMs: 500
      });
    } catch (error) {
      throw new TransientJobError('AI connector request failed', error);
    }

    const choice = apiResponse.choices?.[0];
    if (!choice?.message?.content) {
      throw new PermanentJobError('AI connector returned no content');
    }

    let parsed: AiTaggingResponse;
    try {
      parsed = JSON.parse(choice.message.content) as AiTaggingResponse;
    } catch (error) {
      throw new PermanentJobError('AI connector response was not valid JSON', error);
    }

    if (!Array.isArray(parsed.repository_tags)) {
      throw new PermanentJobError('AI connector response missing repository_tags array');
    }

    const metrics: TaggingJobMetrics = {
      promptTokens: apiResponse.usage?.prompt_tokens ?? undefined,
      completionTokens: apiResponse.usage?.completion_tokens ?? undefined
    };

    return { response: parsed, metrics };
  }
}
