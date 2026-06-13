import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  RequestTimeoutException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AiChatService } from '../ai-chat/ai-chat.service';
import {
  AGENT_TOOL_PACKS,
  AgentRunContext,
  AgentRuntimeEventHandler,
  AgentToolBindingRow,
  AgentToolDefinition,
  AgentToolPackKey,
} from './ai-agents.types';

@Injectable()
export class AiAgentRuntimeService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly aiChatService: AiChatService,
  ) {}

  listToolCatalog() {
    const items = this.getToolDefinitions()
      .filter((tool) => tool.safety_level === 'readonly')
      .map((tool) => ({
        key: tool.key,
        name: tool.name,
        description: tool.description,
        tool_pack: tool.tool_pack,
        safety_level: tool.safety_level,
        input_schema: tool.input_schema,
      }));
    return {
      packs: AGENT_TOOL_PACKS,
      items,
    };
  }

  hasTool(toolKey: string) {
    return this.getToolDefinitions().some((item) => item.key === toolKey);
  }

  async execute(
    context: AgentRunContext,
    input: {
      runId: string;
      inputText: string;
      inputJson: Record<string, unknown>;
      variables: Record<string, unknown>;
    },
    options?: {
      onEvent?: AgentRuntimeEventHandler;
    },
  ) {
    const toolRegistry = this.getToolDefinitions();
    const versionTools = await this.listToolBindingsByVersionId(context.version.id);
    const resolvedToolPacks = this.resolveEnabledToolPacks(
      this.parseJsonObject(context.version.tool_policy_json),
      this.parseJsonObject(context.binding.tool_override_json),
    );
    const enabledTools = versionTools
      .filter((item) => item.is_enabled)
      .map((item) => ({
        binding: item,
        definition: toolRegistry.find((tool) => tool.key === item.tool_key) || null,
      }))
      .filter((item): item is { binding: AgentToolBindingRow; definition: AgentToolDefinition } => !!item.definition)
      .filter((item) => item.definition.safety_level === 'readonly')
      .filter((item) => resolvedToolPacks.length === 0 || resolvedToolPacks.includes(item.definition.tool_pack));

    const debugSteps: Array<Record<string, unknown>> = [];
    const toolSpecs = enabledTools.map((item) => ({
      type: 'function',
      function: {
        name: item.definition.key,
        description: item.definition.description,
        parameters: item.definition.input_schema,
      },
    }));

    this.validateSchema(context.version.input_schema_json, input.inputJson, 'input');

    const maxSteps = Math.max(1, context.version.max_steps || 6);
    const maxToolCalls = Math.max(0, context.version.max_tool_calls || 8);
    const deadlineAt = Date.now() + Math.max(1000, Number(context.version.timeout_ms || 60000));
    const model = this.normalizeOptionalString(context.binding.model_override, 255)
      || this.normalizeOptionalString(context.version.default_model, 255)
      || undefined;
    await this.insertRunStep(input.runId, 0, 'runtime_start', {
      latency_ms: 0,
      payload: {
        agent_id: context.agent.id,
        agent_slug: context.agent.slug,
        route_slug: context.binding.route_slug,
        app_id: context.app.id,
        app_slug: context.app.slug,
        model_key: model || null,
        output_mode: context.version.output_mode,
        max_steps: maxSteps,
        max_tool_calls: maxToolCalls,
        timeout_ms: Math.max(1000, Number(context.version.timeout_ms || 60000)),
        enabled_tools: enabledTools.map((item) => item.definition.key),
      },
    });
    const variables = {
      ...input.variables,
      app_slug: context.app.slug,
      app_name: context.app.name,
      current_time: new Date().toISOString(),
      user_id: context.actor.userId,
      user_email: context.actor.email,
      agent_name: context.agent.name,
    };
    const systemPrompt = this.interpolateTemplate(context.version.system_prompt_template, variables);
    const developerPrompt = this.interpolateTemplate(
      this.normalizeOptionalString(context.binding.system_prompt_override, 12000)
        || context.version.developer_prompt_template
        || '',
      variables,
    );

    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    if (developerPrompt) {
      messages.push({ role: 'system', content: `Developer instructions:\n${developerPrompt}` });
    }
    messages.push({ role: 'user', content: input.inputText });

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalToolCalls = 0;
    let finalText = '';
    let finalJson: Record<string, unknown> = {};

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      this.assertWithinDeadline(deadlineAt);
      const startedAt = Date.now();
      const forwarded = await this.withDeadline(
        this.aiChatService.forwardChatCompletions(
          context.app.slug,
          {
            model,
            stream: false,
            messages,
            tools: toolSpecs.length ? toolSpecs : undefined,
            tool_choice: toolSpecs.length ? 'auto' : undefined,
            response_format: context.version.output_mode === 'json'
              ? { type: 'json_object' }
              : undefined,
          },
          {
            user_id: context.actor.userId,
            request_path: `/agent/${context.binding.route_slug}/run`,
          },
        ),
        deadlineAt,
        'agent model call timed out',
      );
      if (forwarded.stream || ('binary' in forwarded && forwarded.binary)) {
        throw new BadGatewayException('invalid agent upstream response');
      }
      if (!('data' in forwarded)) {
        throw new BadGatewayException('invalid agent upstream payload');
      }
      const data = forwarded.data || {};
      const usage = this.extractUsage(data);
      totalPromptTokens += usage.prompt_tokens;
      totalCompletionTokens += usage.completion_tokens;

      const message = this.extractAssistantMessage(data);
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      const assistantContent = this.extractAssistantContent(message?.content);

      await this.insertRunStep(input.runId, stepIndex + 1, 'model_response', {
        latency_ms: Date.now() - startedAt,
        payload: {
          usage,
          content_preview: assistantContent.slice(0, 500),
          tool_calls: toolCalls,
        },
      });
      await options?.onEvent?.('agent.step.model_response', {
        run_id: input.runId,
        step_index: stepIndex,
        usage,
        content_preview: assistantContent.slice(0, 500),
        tool_calls: toolCalls,
      });
      debugSteps.push({
        step: stepIndex,
        kind: 'model_response',
        usage,
        content: assistantContent,
        tool_calls: toolCalls,
      });

      if (!toolCalls.length) {
        finalText = assistantContent;
        finalJson = context.version.output_mode === 'json' ? this.tryParseJsonObject(assistantContent) : {};
        if (!finalText && context.version.output_mode !== 'json') {
          throw new BadGatewayException('agent returned empty output');
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: message?.content ?? assistantContent,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        totalToolCalls += 1;
        if (totalToolCalls > maxToolCalls) {
          throw new BadRequestException('agent exceeded max tool calls');
        }
        const functionName = String(toolCall?.function?.name || '').trim();
        const toolDef = enabledTools.find((item) => item.definition.key === functionName);
        const args = this.tryParseJsonObject(String(toolCall?.function?.arguments || '{}'));
        let toolResult: Record<string, unknown>;
        if (!toolDef) {
          toolResult = {
            ok: false,
            error: `unknown tool: ${functionName}`,
          };
        } else {
          try {
            toolResult = await this.withDeadline(
              toolDef.definition.execute({
                app: context.app,
                actor: context.actor,
                args,
              }),
              deadlineAt,
              `agent tool timed out: ${functionName}`,
            );
          } catch (error) {
            if (error instanceof RequestTimeoutException) {
              throw error;
            }
            toolResult = {
              ok: false,
              error: error instanceof Error ? error.message : 'tool execution failed',
            };
          }
        }
        await this.insertRunStep(input.runId, stepIndex + 1, 'tool_call', {
          latency_ms: 0,
          payload: {
            tool_name: functionName,
            arguments: args,
            result: toolResult,
          },
        });
        await options?.onEvent?.('agent.step.tool_call', {
          run_id: input.runId,
          step_index: stepIndex,
          tool_name: functionName,
          arguments: args,
          result: toolResult,
        });
        debugSteps.push({
          step: stepIndex,
          kind: 'tool_call',
          tool_name: functionName,
          arguments: args,
          result: toolResult,
        });
        messages.push({
          role: 'tool',
          tool_call_id: String(toolCall?.id || randomUUID()),
          name: functionName,
          content: JSON.stringify(toolResult),
        });
      }
    }

    if (!finalText && context.version.output_mode === 'json' && Object.keys(finalJson).length > 0) {
      finalText = JSON.stringify(finalJson);
    }
    this.validateSchema(
      context.version.output_schema_json,
      this.resolveOutputValidationValue(context.version.output_mode, context.version.output_schema_json, finalText, finalJson),
      'output',
    );

    return {
      output_text: finalText,
      output_json: finalJson,
      total_prompt_tokens: totalPromptTokens,
      total_completion_tokens: totalCompletionTokens,
      total_tool_calls: totalToolCalls,
      model_key: model || null,
      debug_steps: debugSteps,
    };
  }

  private getToolDefinitions(): AgentToolDefinition[] {
    return [
      {
        key: 'get_current_time',
        name: 'Current Time',
        description: 'Get current server time and timezone information.',
        tool_pack: 'core_readonly',
        safety_level: 'readonly',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        execute: async () => ({
          ok: true,
          now_iso: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      },
      {
        key: 'get_current_user_profile',
        name: 'Current User Profile',
        description: 'Read the authenticated user profile in the current app.',
        tool_pack: 'user_readonly',
        safety_level: 'readonly',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        execute: async ({ actor }) => {
          if (!actor.userId) {
            throw new ForbiddenException('authenticated user required');
          }
          const rows = await (this.prisma.$queryRawUnsafe(
            `SELECT id, email, full_name, display_name, role::text AS role, phone
               FROM users
              WHERE id = $1::uuid
              LIMIT 1`,
            actor.userId,
          ) as Promise<Array<{
            id: string;
            email: string;
            full_name: string | null;
            display_name: string | null;
            role: string | null;
            phone: string | null;
          }>>);
          const row = rows[0];
          return {
            ok: true,
            user: row || null,
          };
        },
      },
    ];
  }

  private async listToolBindingsByVersionId(versionId: string) {
    return (this.prisma.$queryRawUnsafe(
      `SELECT * FROM ai_agent_tool_bindings WHERE agent_version_id = $1::uuid ORDER BY tool_key ASC`,
      versionId,
    ) as Promise<AgentToolBindingRow[]>);
  }

  private async insertRunStep(
    runId: string,
    stepIndex: number,
    kind: string,
    input: {
      latency_ms: number;
      payload: Record<string, unknown>;
    },
  ) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ai_agent_run_steps (
         id, run_id, step_index, kind, payload_json, latency_ms, created_at, expires_at
       ) VALUES (
         gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, $5, now(), now() + interval '7 days'
       )`,
      runId,
      stepIndex,
      kind,
      JSON.stringify(input.payload),
      Math.max(0, Math.floor(input.latency_ms || 0)),
    );
  }

  private resolveEnabledToolPacks(
    templatePolicy: Record<string, unknown>,
    bindingOverride: Record<string, unknown>,
  ): AgentToolPackKey[] {
    const bindingPacks = this.normalizeToolPacks(bindingOverride.enabled_tool_packs);
    if (bindingPacks.length > 0) {
      return bindingPacks;
    }
    return this.normalizeToolPacks(templatePolicy.enabled_tool_packs);
  }

  private normalizeToolPacks(raw: unknown): AgentToolPackKey[] {
    const values = Array.isArray(raw) ? raw : [];
    const normalized = values
      .map((item) => String(item || '').trim())
      .filter((item): item is AgentToolPackKey => AGENT_TOOL_PACKS.some((pack) => pack.key === item));
    return Array.from(new Set(normalized));
  }

  private normalizeOptionalString(value: unknown, maxLength = 255) {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private parseJsonObject(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return {};
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return {};
      } catch {
        return {};
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private tryParseJsonObject(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(String(value || '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignored
    }
    return {};
  }

  private extractAssistantMessage(data: Record<string, unknown>) {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = (first?.message || {}) as Record<string, unknown>;
    return message;
  }

  private extractAssistantContent(content: unknown): string {
    if (typeof content === 'string') {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && typeof (item as any).text === 'string') return (item as any).text;
          if (item && typeof item === 'object' && typeof (item as any).content === 'string') return (item as any).content;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    return '';
  }

  private extractUsage(data: Record<string, unknown>) {
    const usage = (data.usage || {}) as Record<string, unknown>;
    return {
      prompt_tokens: Number(usage.prompt_tokens || 0),
      completion_tokens: Number(usage.completion_tokens || 0),
    };
  }

  private interpolateTemplate(template: string, variables: Record<string, unknown>) {
    return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
      const value = variables[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  private async withDeadline<T>(promise: Promise<T>, deadlineAt: number, message: string): Promise<T> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new RequestTimeoutException(message);
    }
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new RequestTimeoutException(message)), remainingMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private assertWithinDeadline(deadlineAt: number) {
    if (Date.now() > deadlineAt) {
      throw new RequestTimeoutException('agent run timed out');
    }
  }

  private validateSchema(schemaValue: unknown, value: unknown, label: 'input' | 'output') {
    const schema = this.parseJsonObject(schemaValue);
    if (Object.keys(schema).length === 0) {
      return;
    }
    const errors: string[] = [];
    this.validateSchemaNode(schema, value, label, errors);
    if (errors.length > 0) {
      const message = `agent ${label} schema validation failed: ${errors.slice(0, 5).join('; ')}`;
      if (label === 'output') {
        throw new BadGatewayException(message);
      }
      throw new BadRequestException(message);
    }
  }

  private validateSchemaNode(
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    errors: string[],
  ) {
    if (errors.length >= 10) return;
    const enumValues = Array.isArray(schema.enum) ? schema.enum : null;
    if (enumValues && !enumValues.some((item) => item === value)) {
      errors.push(`${path} must be one of ${enumValues.map((item) => JSON.stringify(item)).join(', ')}`);
      return;
    }

    const type = typeof schema.type === 'string' ? schema.type : '';
    if (type && !this.matchesJsonSchemaType(value, type)) {
      errors.push(`${path} must be ${type}`);
      return;
    }

    if (type === 'object' || (!type && this.isPlainObject(value))) {
      this.validateObjectSchema(schema, value, path, errors);
      return;
    }
    if (type === 'array' || (!type && Array.isArray(value))) {
      this.validateArraySchema(schema, value, path, errors);
      return;
    }
    if (type === 'string' || typeof value === 'string') {
      this.validateStringSchema(schema, value, path, errors);
      return;
    }
    if (type === 'number' || type === 'integer' || typeof value === 'number') {
      this.validateNumberSchema(schema, value, path, errors);
    }
  }

  private validateObjectSchema(
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    errors: string[],
  ) {
    if (!this.isPlainObject(value)) {
      errors.push(`${path} must be object`);
      return;
    }
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.map((item) => String(item)) : [];
    for (const key of required) {
      if (objectValue[key] === undefined) {
        errors.push(`${path}.${key} is required`);
      }
    }
    const properties = this.parseJsonObject(schema.properties);
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (objectValue[key] !== undefined && this.isPlainObject(propertySchema)) {
        this.validateSchemaNode(propertySchema as Record<string, unknown>, objectValue[key], `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(objectValue)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
  }

  private validateArraySchema(
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    errors: string[],
  ) {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be array`);
      return;
    }
    const minItems = this.finiteNumber(schema.minItems);
    const maxItems = this.finiteNumber(schema.maxItems);
    if (minItems !== null && value.length < minItems) {
      errors.push(`${path} must contain at least ${minItems} items`);
    }
    if (maxItems !== null && value.length > maxItems) {
      errors.push(`${path} must contain at most ${maxItems} items`);
    }
    if (this.isPlainObject(schema.items)) {
      value.forEach((item, index) => {
        this.validateSchemaNode(schema.items as Record<string, unknown>, item, `${path}[${index}]`, errors);
      });
    }
  }

  private validateStringSchema(
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    errors: string[],
  ) {
    if (typeof value !== 'string') {
      errors.push(`${path} must be string`);
      return;
    }
    const minLength = this.finiteNumber(schema.minLength);
    const maxLength = this.finiteNumber(schema.maxLength);
    if (minLength !== null && value.length < minLength) {
      errors.push(`${path} must be at least ${minLength} characters`);
    }
    if (maxLength !== null && value.length > maxLength) {
      errors.push(`${path} must be at most ${maxLength} characters`);
    }
  }

  private validateNumberSchema(
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    errors: string[],
  ) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path} must be number`);
      return;
    }
    const minimum = this.finiteNumber(schema.minimum);
    const maximum = this.finiteNumber(schema.maximum);
    if (minimum !== null && value < minimum) {
      errors.push(`${path} must be >= ${minimum}`);
    }
    if (maximum !== null && value > maximum) {
      errors.push(`${path} must be <= ${maximum}`);
    }
  }

  private matchesJsonSchemaType(value: unknown, type: string) {
    if (type === 'object') return this.isPlainObject(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'null') return value === null;
    return true;
  }

  private resolveOutputValidationValue(
    outputMode: string,
    schemaValue: unknown,
    outputText: string,
    outputJson: Record<string, unknown>,
  ) {
    const schema = this.parseJsonObject(schemaValue);
    if (schema.type === 'string') {
      return outputText;
    }
    if (outputMode === 'json') {
      return outputJson;
    }
    return { output_text: outputText };
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private finiteNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
