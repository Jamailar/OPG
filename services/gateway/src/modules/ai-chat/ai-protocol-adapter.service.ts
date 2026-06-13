import { Injectable } from '@nestjs/common';
import { ResolvedAiRoute } from './ai-routing.service';

@Injectable()
export class AiProtocolAdapterService {
  withOpenAiStreamUsageOptions(route: ResolvedAiRoute, payload: Record<string, unknown>): Record<string, unknown> {
    if (!this.isStreamingRequest(payload) || !this.isOpenAiCompatibleSource(route.source.provider_type, route.source.base_url)) {
      return payload;
    }
    const endpointPath = this.normalizeEndpointPath(route.endpoint_path || '/chat/completions');
    if (endpointPath !== '/chat/completions' && endpointPath !== '/v1/chat/completions') {
      return payload;
    }
    const currentOptions = this.normalizeObject(payload.stream_options);
    if (currentOptions.include_usage === true || currentOptions.include_usage === 'true') {
      return payload;
    }
    return {
      ...payload,
      stream_options: {
        ...currentOptions,
        include_usage: true,
      },
    };
  }

  private isStreamingRequest(payload: Record<string, unknown>): boolean {
    return payload.stream === true || payload.stream === 'true';
  }

  private isOpenAiCompatibleSource(providerType: string, baseUrl: string): boolean {
    if (this.isGeminiSource(providerType, baseUrl) || this.isAnthropicSource(providerType, baseUrl)) {
      return false;
    }
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    if (provider.includes('openai') || provider.includes('compat') || provider.includes('openrouter')) {
      return true;
    }
    if (provider.includes('deepseek') || provider.includes('moonshot') || provider.includes('siliconflow')) {
      return true;
    }
    if (provider.includes('minimax')) {
      return false;
    }
    return /\/v1$/i.test(url) && !provider.includes('dashscope') && !url.includes('dashscope');
  }

  private isAnthropicSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('anthropic') || url.includes('api.anthropic.com') || url.includes('/anthropic');
  }

  private isGeminiSource(providerType: string, baseUrl: string): boolean {
    const provider = String(providerType || '').trim().toLowerCase();
    const url = String(baseUrl || '').trim().toLowerCase();
    return provider.includes('gemini')
      || provider.includes('google')
      || url.includes('generativelanguage.googleapis.com')
      || url.includes('aiplatform.googleapis.com')
      || url.includes('/models/gemini');
  }

  private normalizeEndpointPath(raw: string): string {
    const value = String(raw || '').trim();
    if (!value) {
      return '/chat/completions';
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        return parsed.pathname || '/';
      } catch {
        return value;
      }
    }
    return value.startsWith('/') ? value : `/${value}`;
  }

  private normalizeObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
