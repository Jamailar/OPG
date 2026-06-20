import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AppDataColumnRow, AppDataPolicyRow, AppDataTableRow } from './app-schema.types';

type PolicyAction = 'read' | 'create' | 'update' | 'delete';
type CompiledCondition = { sql: string; params: unknown[] };

export type PolicyActorContext = {
  appId: string;
  role: string;
  userId: string | null;
  apiKeyId: string | null;
  apiKeyScopes: string[];
  privileged: boolean;
};

export type CompiledReadPolicy = {
  where: string[];
  params: unknown[];
  visibleColumns: AppDataColumnRow[];
};

@Injectable()
export class PolicyEngineService {
  compileReadPolicy(input: {
    table: AppDataTableRow;
    columns: AppDataColumnRow[];
    policies: AppDataPolicyRow[];
    actor: PolicyActorContext;
    paramOffset: number;
  }): CompiledReadPolicy {
    const baseVisible = input.columns.filter((column) => !column.is_hidden);
    if (input.actor.privileged) {
      return { where: [], params: [], visibleColumns: baseVisible };
    }

    const compiled = this.compileAllowDeny(input.policies, input.columns, input.actor, 'read', input.paramOffset);
    if (!compiled.allow.length) {
      throw new ForbiddenException('No active read policy allows this actor');
    }

    const hidden = this.resolveHiddenFields(input.policies, input.actor, 'read');
    return {
      where: [
        `(${compiled.allow.map((item) => `(${item.sql})`).join(' OR ')})`,
        ...(compiled.deny.length ? [`NOT (${compiled.deny.map((item) => `(${item.sql})`).join(' OR ')})`] : []),
      ],
      params: compiled.params,
      visibleColumns: baseVisible.filter((column) => !hidden.has(column.slug)),
    };
  }

  compileRowWritePolicy(input: {
    columns: AppDataColumnRow[];
    policies: AppDataPolicyRow[];
    actor: PolicyActorContext;
    action: 'update' | 'delete';
    paramOffset: number;
  }) {
    if (input.actor.privileged) {
      return { where: [], params: [] };
    }
    const compiled = this.compileAllowDeny(input.policies, input.columns, input.actor, input.action, input.paramOffset);
    if (!compiled.allow.length) {
      throw new ForbiddenException(`No active ${input.action} policy allows this actor`);
    }
    return {
      where: [
        `(${compiled.allow.map((item) => `(${item.sql})`).join(' OR ')})`,
        ...(compiled.deny.length ? [`NOT (${compiled.deny.map((item) => `(${item.sql})`).join(' OR ')})`] : []),
      ],
      params: compiled.params,
    };
  }

  assertCreateAllowed(input: {
    columns: AppDataColumnRow[];
    policies: AppDataPolicyRow[];
    actor: PolicyActorContext;
    payload: Record<string, unknown>;
  }) {
    if (input.actor.privileged) {
      return;
    }
    const matching = this.matchPolicies(input.policies, input.actor, 'create');
    const denies = matching.filter((policy) => policy.effect === 'deny');
    if (denies.some((policy) => this.evaluateCondition(policy.condition_json, input.columns, input.actor, input.payload))) {
      throw new ForbiddenException('Create denied by policy');
    }
    const allows = matching.filter((policy) => policy.effect === 'allow');
    if (!allows.some((policy) => this.evaluateCondition(policy.condition_json, input.columns, input.actor, input.payload))) {
      throw new ForbiddenException('No active create policy allows this actor');
    }
  }

  validatePolicy(input: { columns: AppDataColumnRow[]; condition: unknown; fieldMask: unknown }) {
    this.validateCondition(input.condition || {}, new Set(input.columns.map((column) => column.slug)), 0);
    const fieldMask = this.jsonObject(input.fieldMask);
    const hidden = Array.isArray(fieldMask.hide) ? fieldMask.hide : [];
    for (const field of hidden) {
      if (!input.columns.some((column) => column.slug === field)) {
        throw new BadRequestException(`field_mask.hide contains unknown field: ${field}`);
      }
    }
  }

  templatePolicy(template: string, table: AppDataTableRow) {
    const normalized = String(template || '').trim();
    if (normalized === 'public_read_admin_write') {
      return [
        { action: 'read', effect: 'allow', roles: ['USER', 'ANONYMOUS'], condition: {}, field_mask: {} },
        { action: 'all', effect: 'allow', roles: ['ADMIN', 'SERVICE_KEY', 'DEVELOPER'], condition: {}, field_mask: {} },
      ];
    }
    if (normalized === 'owner_read_write') {
      if (!table.owner_column) throw new BadRequestException('owner_read_write requires owner_column');
      const condition = { field: table.owner_column, op: 'eq', value: '$auth.user_id' };
      return [
        { action: 'read', effect: 'allow', roles: ['USER'], condition, field_mask: {} },
        { action: 'update', effect: 'allow', roles: ['USER'], condition, field_mask: {} },
        { action: 'delete', effect: 'allow', roles: ['USER'], condition, field_mask: {} },
      ];
    }
    if (normalized === 'admin_only') {
      return [{ action: 'all', effect: 'allow', roles: ['ADMIN'], condition: {}, field_mask: {} }];
    }
    if (normalized === 'service_key_only') {
      return [{ action: 'all', effect: 'allow', roles: ['SERVICE_KEY'], condition: {}, field_mask: {} }];
    }
    if (normalized === 'authenticated_insert_owner_read') {
      if (!table.owner_column) throw new BadRequestException('authenticated_insert_owner_read requires owner_column');
      return [
        { action: 'create', effect: 'allow', roles: ['USER'], condition: { field: table.owner_column, op: 'eq', value: '$auth.user_id' }, field_mask: {} },
        { action: 'read', effect: 'allow', roles: ['USER'], condition: { field: table.owner_column, op: 'eq', value: '$auth.user_id' }, field_mask: {} },
      ];
    }
    throw new BadRequestException(`Unknown policy template: ${normalized || '(empty)'}`);
  }

  buildActorContext(appId: string, actor: any): PolicyActorContext {
    const authMode = String(actor?.authMode || '').trim();
    const role = this.resolveActorRole(actor);
    return {
      appId,
      role,
      userId: this.optionalUuid(actor?.userId || actor?.id),
      apiKeyId: this.optionalUuid(actor?.apiKeyId),
      apiKeyScopes: Array.isArray(actor?.scopes) ? actor.scopes.map((item: unknown) => String(item)) : [],
      privileged: role === 'ADMIN' || role === 'SERVICE_KEY' || role === 'DEVELOPER' || authMode === 'api_key' || authMode === 'developer_grant',
    };
  }

  private compileAllowDeny(
    policies: AppDataPolicyRow[],
    columns: AppDataColumnRow[],
    actor: PolicyActorContext,
    action: PolicyAction,
    paramOffset: number,
  ) {
    const matching = this.matchPolicies(policies, actor, action);
    const allow: CompiledCondition[] = [];
    const deny: CompiledCondition[] = [];
    let offset = paramOffset;
    const params: unknown[] = [];
    for (const policy of matching) {
      const compiled = this.compileCondition(policy.condition_json, columns, actor, offset);
      offset += compiled.params.length;
      params.push(...compiled.params);
      if (policy.effect === 'deny') {
        deny.push(compiled);
      } else {
        allow.push(compiled);
      }
    }
    return {
      allow,
      deny,
      params,
    };
  }

  private matchPolicies(policies: AppDataPolicyRow[], actor: PolicyActorContext, action: PolicyAction) {
    return policies
      .filter((policy) => policy.status === 'ACTIVE')
      .filter((policy) => policy.action === action || policy.action === 'all')
      .filter((policy) => {
        const roles = this.stringArray(policy.roles_json).map((role) => role.toUpperCase());
        return !roles.length || roles.includes(actor.role);
      });
  }

  private compileCondition(condition: unknown, columns: AppDataColumnRow[], actor: PolicyActorContext, paramOffset: number): CompiledCondition {
    let nextParam = paramOffset;
    return this.compileConditionWithCursor(condition, columns, actor, () => {
      nextParam += 1;
      return nextParam;
    });
  }

  private compileConditionWithCursor(condition: unknown, columns: AppDataColumnRow[], actor: PolicyActorContext, nextParam: () => number): CompiledCondition {
    const normalized = this.jsonObject(condition);
    if (!Object.keys(normalized).length) {
      return { sql: 'TRUE', params: [] };
    }
    if (Array.isArray(normalized.all)) {
      const compiled = normalized.all.map((item) => this.compileConditionWithCursor(item, columns, actor, nextParam));
      return {
        sql: compiled.length ? compiled.map((item) => `(${item.sql})`).join(' AND ') : 'TRUE',
        params: compiled.flatMap((item) => item.params),
      };
    }
    if (Array.isArray(normalized.any)) {
      const compiled = normalized.any.map((item) => this.compileConditionWithCursor(item, columns, actor, nextParam));
      return {
        sql: compiled.length ? compiled.map((item) => `(${item.sql})`).join(' OR ') : 'FALSE',
        params: compiled.flatMap((item) => item.params),
      };
    }
    const field = String(normalized.field || '').trim();
    const column = columns.find((item) => item.slug === field);
    if (!column) {
      throw new BadRequestException(`Unknown policy field: ${field || '(empty)'}`);
    }
    const op = String(normalized.op || 'eq').trim();
    if (op === 'is_null') return { sql: `${this.q(column.physical_column_name)} IS NULL`, params: [] };
    if (op === 'not_null') return { sql: `${this.q(column.physical_column_name)} IS NOT NULL`, params: [] };
    const value = this.resolveValue(normalized.value, actor);
    if (op === 'eq') return { sql: `${this.q(column.physical_column_name)} = $${nextParam()}`, params: [value] };
    if (op === 'ne') return { sql: `${this.q(column.physical_column_name)} <> $${nextParam()}`, params: [value] };
    if (op === 'in') {
      const values = Array.isArray(value) ? value : [value];
      return { sql: `${this.q(column.physical_column_name)} = ANY($${nextParam()})`, params: [values] };
    }
    throw new BadRequestException(`Unsupported policy op: ${op}`);
  }

  private evaluateCondition(condition: unknown, columns: AppDataColumnRow[], actor: PolicyActorContext, payload: Record<string, unknown>): boolean {
    const normalized = this.jsonObject(condition);
    if (!Object.keys(normalized).length) return true;
    if (Array.isArray(normalized.all)) return normalized.all.every((item) => this.evaluateCondition(item, columns, actor, payload));
    if (Array.isArray(normalized.any)) return normalized.any.some((item) => this.evaluateCondition(item, columns, actor, payload));
    const field = String(normalized.field || '').trim();
    const column = columns.find((item) => item.slug === field || item.physical_column_name === field);
    if (!column) throw new BadRequestException(`Unknown policy field: ${field || '(empty)'}`);
    const actual = payload[column.physical_column_name] ?? payload[column.slug] ?? null;
    const expected = this.resolveValue(normalized.value, actor);
    const op = String(normalized.op || 'eq').trim();
    if (op === 'is_null') return actual === null || actual === undefined;
    if (op === 'not_null') return actual !== null && actual !== undefined;
    if (op === 'eq') return String(actual ?? '') === String(expected ?? '');
    if (op === 'ne') return String(actual ?? '') !== String(expected ?? '');
    if (op === 'in') return (Array.isArray(expected) ? expected : [expected]).map((item) => String(item)).includes(String(actual));
    throw new BadRequestException(`Unsupported policy op: ${op}`);
  }

  private validateCondition(condition: unknown, fields: Set<string>, depth: number) {
    if (depth > 6) throw new BadRequestException('Policy condition is too deep');
    const normalized = this.jsonObject(condition);
    if (!Object.keys(normalized).length) return;
    if (Array.isArray(normalized.all)) {
      normalized.all.forEach((item) => this.validateCondition(item, fields, depth + 1));
      return;
    }
    if (Array.isArray(normalized.any)) {
      normalized.any.forEach((item) => this.validateCondition(item, fields, depth + 1));
      return;
    }
    const field = String(normalized.field || '').trim();
    if (!fields.has(field)) throw new BadRequestException(`Unknown policy field: ${field || '(empty)'}`);
    const op = String(normalized.op || '').trim();
    if (!['eq', 'ne', 'is_null', 'not_null', 'in'].includes(op)) throw new BadRequestException(`Unsupported policy op: ${op || '(empty)'}`);
  }

  private resolveHiddenFields(policies: AppDataPolicyRow[], actor: PolicyActorContext, action: PolicyAction) {
    const hidden = new Set<string>();
    for (const policy of this.matchPolicies(policies, actor, action)) {
      const mask = this.jsonObject(policy.field_mask_json);
      const fields = Array.isArray(mask.hide) ? mask.hide : [];
      fields.forEach((field) => hidden.add(String(field)));
    }
    return hidden;
  }

  private resolveValue(value: unknown, actor: PolicyActorContext): unknown {
    if (value === '$auth.user_id') return actor.userId;
    if (value === '$auth.role') return actor.role;
    if (value === '$app.id') return actor.appId;
    if (value === '$request.api_key_scope') return actor.apiKeyScopes;
    return value;
  }

  private resolveActorRole(actor: any) {
    const authMode = String(actor?.authMode || '').trim();
    if (authMode === 'api_key') return 'SERVICE_KEY';
    if (authMode === 'developer_grant') return 'DEVELOPER';
    const role = String(actor?.role || '').trim().toUpperCase();
    if (role === 'ADMIN') return 'ADMIN';
    if (role === 'USER') return 'USER';
    return actor ? 'USER' : 'ANONYMOUS';
  }

  private stringArray(value: unknown) {
    return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  }

  private jsonObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private optionalUuid(value: unknown) {
    const normalized = String(value || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized) ? normalized : null;
  }

  private q(identifier: string) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
}
