import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PRISMA_CLIENT } from '../../config/database.module';
import { AcquisitionService } from '../acquisition/acquisition.service';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { AuthService } from '../auth/auth.service';

type Row = Record<string, any>;

type AppRow = {
  id: string;
  slug: string;
  name: string;
};

type FormRow = {
  id: string;
  app_id: string;
  form_key: string;
  name: string;
  description: string | null;
  form_type: string;
  status: string;
  title: string;
  subtitle: string | null;
  submit_label: string;
  success_title: string;
  success_message: string | null;
  theme_json: unknown;
  settings_json: unknown;
  variables_json: unknown;
  endings_json: unknown;
  notification_json: unknown;
  published_version_id: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

type QuestionRow = {
  id: string;
  app_id: string;
  form_id: string;
  question_key: string;
  type: string;
  title: string;
  description: string | null;
  required: boolean;
  sort_order: number;
  options_json: unknown;
  validation_json: unknown;
  properties_json: unknown;
  visibility_json: unknown;
  created_at: Date;
  updated_at: Date;
};

type LogicRuleRow = {
  id: string;
  app_id: string;
  form_id: string;
  name: string;
  rule_type: string;
  enabled: boolean;
  sort_order: number;
  conditions_json: unknown;
  actions_json: unknown;
  created_at: Date;
  updated_at: Date;
};

type ActionRow = {
  id: string;
  app_id: string;
  form_id: string;
  name: string;
  action_type: string;
  enabled: boolean;
  trigger_event: string;
  run_async: boolean;
  filters_json: unknown;
  config_json: unknown;
  created_at: Date;
  updated_at: Date;
};

const QUESTION_TYPES = new Set([
  'short_text',
  'long_text',
  'email',
  'url',
  'phone',
  'number',
  'single_select',
  'multi_select',
  'source_select',
  'rating',
  'nps',
  'opinion_scale',
  'boolean',
  'consent',
  'date',
  'statement',
  'hidden',
]);

const DEFAULT_SOURCE_OPTIONS = [
  ['google_search', 'Google 搜索', false, 10],
  ['xiaohongshu', '小红书', false, 20],
  ['wechat', '微信', false, 30],
  ['friend_referral', '朋友推荐', false, 40],
  ['app_store', '应用商店', false, 50],
  ['paid_ads', '广告', false, 60],
  ['other', '其他', true, 100],
] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

@Injectable()
export class AppFormsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly authService: AuthService,
    private readonly acquisitionService: AcquisitionService,
    private readonly adminNotificationsService: AdminNotificationsService,
  ) {}

  async listForms(appId: string) {
    const app = await this.ensureAppExists(appId);
    await this.ensureDefaultForms(app.id);
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         f.*,
         v.version AS published_version,
         v.schema_hash AS published_schema_hash,
         v.published_at AS published_at,
         COUNT(r.id)::bigint AS response_count,
         MAX(r.submitted_at) AS last_response_at
       FROM app_forms f
       LEFT JOIN app_form_versions v ON v.id = f.published_version_id
       LEFT JOIN app_form_responses r ON r.form_id = f.id
       WHERE f.app_id = $1::uuid
         AND f.deleted_at IS NULL
       GROUP BY f.id, v.id
       ORDER BY
         CASE f.form_type WHEN 'SYSTEM_USER_SOURCE' THEN 0 WHEN 'SYSTEM_NPS' THEN 1 ELSE 2 END,
         f.updated_at DESC`,
      app.id,
    ) as Promise<Array<FormRow & Row>>);

    return {
      items: rows.map((row) => this.serializeFormListItem(row, app)),
    };
  }

  async createForm(appId: string, actorUserId: string | null | undefined, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    await this.ensureDefaultForms(app.id);
    const body = asObject(payload);
    const name = this.requiredString(body.name, 'name', 160);
    const key = this.normalizeKey(body.form_key || body.key || name);
    const title = this.optionalString(body.title, 180) || name;
    const submitLabel = this.optionalString(body.submit_label || body.submitLabel, 80) || '提交';
    const successTitle = this.optionalString(body.success_title || body.successTitle, 160) || '提交成功';
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_forms (
         id, app_id, form_key, name, description, form_type, status, title, subtitle,
         submit_label, success_title, success_message, theme_json, settings_json,
         variables_json, endings_json, notification_json, created_by_user_id, updated_by_user_id,
         created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::text, $3::text, $4::text, 'CUSTOM', 'DRAFT',
         $5::text, $6::text, $7::text, $8::text, $9::text, $10::jsonb, $11::jsonb,
         $12::jsonb, $13::jsonb, $14::jsonb, $15::uuid, $15::uuid, now(), now()
       )
       RETURNING *`,
      app.id,
      key,
      name,
      this.optionalString(body.description, 2000),
      title,
      this.optionalString(body.subtitle, 2000),
      submitLabel,
      successTitle,
      this.optionalString(body.success_message || body.successMessage, 2000),
      JSON.stringify(this.normalizeTheme(body.theme)),
      JSON.stringify(this.normalizeSettings(body.settings)),
      JSON.stringify(asObject(body.variables)),
      JSON.stringify(asArray(body.endings)),
      JSON.stringify(asObject(body.notification)),
      this.optionalUuid(actorUserId),
    ) as Promise<FormRow[]>);
    return this.getForm(app.id, rows[0].id);
  }

  async getForm(appId: string, formRef: string) {
    const app = await this.ensureAppExists(appId);
    await this.ensureDefaultForms(app.id);
    const form = await this.getFormRow(app.id, formRef);
    const [questions, rules, actions, versions, metrics] = await Promise.all([
      this.loadQuestions(form.id),
      this.loadLogicRules(form.id),
      this.loadActions(form.id),
      this.loadVersions(form.id),
      this.getMetrics(app.id, form.id),
    ]);
    return {
      item: this.serializeFormDetail(form, app, questions, rules, actions, versions, metrics),
    };
  }

  async updateForm(appId: string, formRef: string, actorUserId: string | null | undefined, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const body = asObject(payload);
    const name = body.name === undefined ? form.name : this.requiredString(body.name, 'name', 160);
    const formKey = String(form.form_type || '').startsWith('SYSTEM_')
      ? form.form_key
      : body.form_key === undefined && body.key === undefined
      ? form.form_key
      : this.normalizeKey(body.form_key || body.key);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE app_forms
       SET form_key = $3::text,
           name = $4::text,
           description = $5::text,
           title = $6::text,
           subtitle = $7::text,
           submit_label = $8::text,
           success_title = $9::text,
           success_message = $10::text,
           theme_json = $11::jsonb,
           settings_json = $12::jsonb,
           variables_json = $13::jsonb,
           endings_json = $14::jsonb,
           notification_json = $15::jsonb,
           updated_by_user_id = $16::uuid,
           updated_at = now()
       WHERE app_id = $1::uuid
         AND id = $2::uuid
         AND deleted_at IS NULL
       RETURNING *`,
      app.id,
      form.id,
      formKey,
      name,
      body.description === undefined ? form.description : this.optionalString(body.description, 2000),
      body.title === undefined ? form.title : this.requiredString(body.title, 'title', 180),
      body.subtitle === undefined ? form.subtitle : this.optionalString(body.subtitle, 2000),
      body.submit_label === undefined && body.submitLabel === undefined ? form.submit_label : this.optionalString(body.submit_label || body.submitLabel, 80) || '提交',
      body.success_title === undefined && body.successTitle === undefined ? form.success_title : this.optionalString(body.success_title || body.successTitle, 160) || '提交成功',
      body.success_message === undefined && body.successMessage === undefined ? form.success_message : this.optionalString(body.success_message || body.successMessage, 2000),
      JSON.stringify(body.theme === undefined ? asObject(form.theme_json) : this.normalizeTheme(body.theme)),
      JSON.stringify(body.settings === undefined ? asObject(form.settings_json) : this.normalizeSettings(body.settings)),
      JSON.stringify(body.variables === undefined ? asObject(form.variables_json) : asObject(body.variables)),
      JSON.stringify(body.endings === undefined ? asArray(form.endings_json) : asArray(body.endings)),
      JSON.stringify(body.notification === undefined ? asObject(form.notification_json) : asObject(body.notification)),
      this.optionalUuid(actorUserId),
    ) as Promise<FormRow[]>);
    return this.getForm(app.id, rows[0].id);
  }

  async deleteForm(appId: string, formRef: string) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    if (String(form.form_type || '').startsWith('SYSTEM_')) {
      throw new BadRequestException('系统表单不能删除');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_forms
       SET status = 'DELETED', deleted_at = now(), updated_at = now()
       WHERE app_id = $1::uuid AND id = $2::uuid`,
      app.id,
      form.id,
    );
    return { deleted: true };
  }

  async publishForm(appId: string, formRef: string, actorUserId?: string | null) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const version = await this.publishFormRow(app, form, actorUserId || null);
    return {
      item: this.serializeVersion(version),
      manifest: version.manifest_json,
    };
  }

  async createQuestion(appId: string, formRef: string, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const body = asObject(payload);
    const type = this.normalizeQuestionType(body.type);
    const title = this.requiredString(body.title, 'title', 240);
    const key = this.normalizeKey(body.question_key || body.key || title);
    const sortOrder = this.integer(body.sort_order || body.sortOrder, await this.nextQuestionSortOrder(form.id));
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_form_questions (
         id, app_id, form_id, question_key, type, title, description, required, sort_order,
         options_json, validation_json, properties_json, visibility_json, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
         $7::boolean, $8::int, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, now(), now()
       )
       RETURNING *`,
      app.id,
      form.id,
      key,
      type,
      title,
      this.optionalString(body.description, 2000),
      this.boolean(body.required, false),
      sortOrder,
      JSON.stringify(this.normalizeOptions(body.options)),
      JSON.stringify(asObject(body.validation)),
      JSON.stringify(asObject(body.properties)),
      JSON.stringify(asObject(body.visibility)),
    ) as Promise<QuestionRow[]>);
    await this.touchForm(form.id);
    return { item: this.serializeQuestion(rows[0]) };
  }

  async updateQuestion(appId: string, formRef: string, questionId: string, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const question = await this.getQuestionRow(form.id, questionId);
    const body = asObject(payload);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE app_form_questions
       SET question_key = $3::text,
           type = $4::text,
           title = $5::text,
           description = $6::text,
           required = $7::boolean,
           sort_order = $8::int,
           options_json = $9::jsonb,
           validation_json = $10::jsonb,
           properties_json = $11::jsonb,
           visibility_json = $12::jsonb,
           updated_at = now()
       WHERE form_id = $1::uuid AND id = $2::uuid
       RETURNING *`,
      form.id,
      question.id,
      body.question_key === undefined && body.key === undefined ? question.question_key : this.normalizeKey(body.question_key || body.key),
      body.type === undefined ? question.type : this.normalizeQuestionType(body.type),
      body.title === undefined ? question.title : this.requiredString(body.title, 'title', 240),
      body.description === undefined ? question.description : this.optionalString(body.description, 2000),
      body.required === undefined ? question.required : this.boolean(body.required, false),
      body.sort_order === undefined && body.sortOrder === undefined ? Number(question.sort_order || 0) : this.integer(body.sort_order || body.sortOrder, 0),
      JSON.stringify(body.options === undefined ? asArray(question.options_json) : this.normalizeOptions(body.options)),
      JSON.stringify(body.validation === undefined ? asObject(question.validation_json) : asObject(body.validation)),
      JSON.stringify(body.properties === undefined ? asObject(question.properties_json) : asObject(body.properties)),
      JSON.stringify(body.visibility === undefined ? asObject(question.visibility_json) : asObject(body.visibility)),
    ) as Promise<QuestionRow[]>);
    await this.touchForm(form.id);
    return { item: this.serializeQuestion(rows[0]) };
  }

  async deleteQuestion(appId: string, formRef: string, questionId: string) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `DELETE FROM app_form_questions
       WHERE form_id = $1::uuid AND id = $2::uuid
       RETURNING id`,
      form.id,
      questionId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) throw new NotFoundException('Question not found');
    await this.touchForm(form.id);
    return { deleted: true };
  }

  async reorderQuestions(appId: string, formRef: string, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const body = asObject(payload);
    const ids = asArray(body.question_ids || body.questionIds).map((item) => String(item || '').trim()).filter(Boolean);
    if (!ids.length) throw new BadRequestException('question_ids is required');
    for (let index = 0; index < ids.length; index += 1) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE app_form_questions
         SET sort_order = $3::int, updated_at = now()
         WHERE form_id = $1::uuid AND id = $2::uuid`,
        form.id,
        ids[index],
        (index + 1) * 10,
      );
    }
    await this.touchForm(form.id);
    return { items: (await this.loadQuestions(form.id)).map((row) => this.serializeQuestion(row)) };
  }

  async createLogicRule(appId: string, formRef: string, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const body = asObject(payload);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_form_logic_rules (
         id, app_id, form_id, name, rule_type, enabled, sort_order,
         conditions_json, actions_json, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::text, $4::text, $5::boolean,
         $6::int, $7::jsonb, $8::jsonb, now(), now()
       )
       RETURNING *`,
      app.id,
      form.id,
      this.requiredString(body.name, 'name', 120),
      this.optionalString(body.rule_type || body.ruleType, 32) || 'visibility',
      this.boolean(body.enabled, true),
      this.integer(body.sort_order || body.sortOrder, 0),
      JSON.stringify(asArray(body.conditions)),
      JSON.stringify(asArray(body.actions)),
    ) as Promise<LogicRuleRow[]>);
    await this.touchForm(form.id);
    return { item: this.serializeLogicRule(rows[0]) };
  }

  async updateLogicRule(appId: string, formRef: string, ruleId: string, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const current = await this.getLogicRuleRow(form.id, ruleId);
    const body = asObject(payload);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE app_form_logic_rules
       SET name = $3::text,
           rule_type = $4::text,
           enabled = $5::boolean,
           sort_order = $6::int,
           conditions_json = $7::jsonb,
           actions_json = $8::jsonb,
           updated_at = now()
       WHERE form_id = $1::uuid AND id = $2::uuid
       RETURNING *`,
      form.id,
      current.id,
      body.name === undefined ? current.name : this.requiredString(body.name, 'name', 120),
      body.rule_type === undefined && body.ruleType === undefined ? current.rule_type : this.optionalString(body.rule_type || body.ruleType, 32) || 'visibility',
      body.enabled === undefined ? current.enabled : this.boolean(body.enabled, true),
      body.sort_order === undefined && body.sortOrder === undefined ? Number(current.sort_order || 0) : this.integer(body.sort_order || body.sortOrder, 0),
      JSON.stringify(body.conditions === undefined ? asArray(current.conditions_json) : asArray(body.conditions)),
      JSON.stringify(body.actions === undefined ? asArray(current.actions_json) : asArray(body.actions)),
    ) as Promise<LogicRuleRow[]>);
    await this.touchForm(form.id);
    return { item: this.serializeLogicRule(rows[0]) };
  }

  async deleteLogicRule(appId: string, formRef: string, ruleId: string) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `DELETE FROM app_form_logic_rules
       WHERE form_id = $1::uuid AND id = $2::uuid
       RETURNING id`,
      form.id,
      ruleId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) throw new NotFoundException('Logic rule not found');
    await this.touchForm(form.id);
    return { deleted: true };
  }

  async createAction(appId: string, formRef: string, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const body = asObject(payload);
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_form_actions (
         id, app_id, form_id, name, action_type, enabled, trigger_event,
         run_async, filters_json, config_json, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::text, $4::text, $5::boolean,
         $6::text, $7::boolean, $8::jsonb, $9::jsonb, now(), now()
       )
       RETURNING *`,
      app.id,
      form.id,
      this.requiredString(body.name, 'name', 120),
      this.requiredString(body.action_type || body.actionType, 'action_type', 48),
      this.boolean(body.enabled, true),
      this.optionalString(body.trigger_event || body.triggerEvent, 80) || 'response.submitted',
      this.boolean(body.run_async || body.runAsync, true),
      JSON.stringify(asArray(body.filters)),
      JSON.stringify(asObject(body.config)),
    ) as Promise<ActionRow[]>);
    await this.touchForm(form.id);
    return { item: this.serializeAction(rows[0]) };
  }

  async updateAction(appId: string, formRef: string, actionId: string, payload: unknown) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const current = await this.getActionRow(form.id, actionId);
    const body = asObject(payload);
    const rows = await (this.prisma.$queryRawUnsafe(
      `UPDATE app_form_actions
       SET name = $3::text,
           action_type = $4::text,
           enabled = $5::boolean,
           trigger_event = $6::text,
           run_async = $7::boolean,
           filters_json = $8::jsonb,
           config_json = $9::jsonb,
           updated_at = now()
       WHERE form_id = $1::uuid AND id = $2::uuid
       RETURNING *`,
      form.id,
      current.id,
      body.name === undefined ? current.name : this.requiredString(body.name, 'name', 120),
      body.action_type === undefined && body.actionType === undefined ? current.action_type : this.requiredString(body.action_type || body.actionType, 'action_type', 48),
      body.enabled === undefined ? current.enabled : this.boolean(body.enabled, true),
      body.trigger_event === undefined && body.triggerEvent === undefined ? current.trigger_event : this.optionalString(body.trigger_event || body.triggerEvent, 80) || 'response.submitted',
      body.run_async === undefined && body.runAsync === undefined ? current.run_async : this.boolean(body.run_async || body.runAsync, true),
      JSON.stringify(body.filters === undefined ? asArray(current.filters_json) : asArray(body.filters)),
      JSON.stringify(body.config === undefined ? asObject(current.config_json) : asObject(body.config)),
    ) as Promise<ActionRow[]>);
    await this.touchForm(form.id);
    return { item: this.serializeAction(rows[0]) };
  }

  async deleteAction(appId: string, formRef: string, actionId: string) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const rows = await (this.prisma.$queryRawUnsafe(
      `DELETE FROM app_form_actions
       WHERE form_id = $1::uuid AND id = $2::uuid
       RETURNING id`,
      form.id,
      actionId,
    ) as Promise<Array<{ id: string }>>);
    if (!rows[0]) throw new NotFoundException('Action not found');
    await this.touchForm(form.id);
    return { deleted: true };
  }

  async getPublicManifest(appSlug: string | undefined, formKey: string) {
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureDefaultForms(app.id);
    let form = await this.getFormRow(app.id, formKey);
    if (String(form.form_type || '').startsWith('SYSTEM_')) {
      await this.publishSystemFormIfChanged(app, form.form_key);
      form = await this.getFormRow(app.id, form.id);
    }
    if (!form.published_version_id) {
      const version = await this.publishFormRow(app, form, null);
      return { manifest: version.manifest_json, etag: version.schema_hash, published_at: this.toIso(version.published_at) };
    }
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM app_form_versions
       WHERE id = $1::uuid AND form_id = $2::uuid
       LIMIT 1`,
      form.published_version_id,
      form.id,
    ) as Promise<Row[]>);
    if (!rows[0]) {
      const version = await this.publishFormRow(app, form, null);
      return { manifest: version.manifest_json, etag: version.schema_hash, published_at: this.toIso(version.published_at) };
    }
    return {
      manifest: rows[0].manifest_json,
      etag: rows[0].schema_hash,
      published_at: this.toIso(rows[0].published_at),
    };
  }

  async submitPublicResponse(appSlug: string | undefined, formKey: string, payload: unknown, request?: any) {
    const app = await this.resolveAppBySlug(appSlug);
    await this.ensureDefaultForms(app.id);
    const form = await this.getFormRow(app.id, formKey);
    if (!form.published_version_id) {
      await this.publishFormRow(app, form, null);
    }
    const manifestResult = await this.getPublicManifest(app.slug, form.form_key);
    const publishedForm = await this.getFormRow(app.id, form.id);
    const manifest = asObject(manifestResult.manifest);
    const formManifest = asObject(manifest.form);
    const settings = asObject(formManifest.settings || form.settings_json);
    const token = this.extractAccessToken(request);
    const authUser = await this.resolveOptionalAuthUser(token, settings, app.slug);
    const userId = authUser?.id || authUser?.userId || null;
    if (!userId && settings.allow_anonymous === false) {
      throw new UnauthorizedException('login required');
    }

    const body = asObject(payload);
    const answersPayload = body.answers === undefined ? body : body.answers;
    const blocks = asArray(manifest.blocks).map((item) => asObject(item));
    const normalizedAnswers = this.normalizeAnswers(blocks, answersPayload);
    const answerMap = new Map(normalizedAnswers.map((item) => [item.question_key, item]));
    const idempotencyKey = this.optionalString(body.idempotency_key || body.idempotencyKey || request?.headers?.['idempotency-key'], 160);
    if (idempotencyKey) {
      const existing = await this.findIdempotentResponse(app.id, form.id, idempotencyKey);
      if (existing) {
        return { message: '提交成功', item: existing, idempotent: true };
      }
    }

    const score = this.resolveResponseScore(form.form_type, answerMap);
    const requestContext = this.buildRequestContext(request);
    const responseRows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_form_responses (
         id, app_id, form_id, form_version_id, user_id, respondent_key, session_id,
         idempotency_key, status, score, score_label, hidden_json, metadata_json,
         request_context_json, started_at, submitted_at, completed_at, duration_ms, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text,
         $7::text, 'submitted', $8::numeric, $9::text, $10::jsonb, $11::jsonb,
         $12::jsonb, $13::timestamptz, now(), now(), $14::int, now()
       )
       RETURNING *`,
      app.id,
      form.id,
      String(publishedForm.published_version_id || form.published_version_id || formManifest.version_id || '') || null,
      this.optionalUuid(userId),
      this.optionalString(body.respondent_key || body.respondentKey, 160),
      this.optionalString(body.session_id || body.sessionId, 160),
      idempotencyKey,
      score.value,
      score.label,
      JSON.stringify(asObject(body.hidden)),
      JSON.stringify(asObject(body.metadata)),
      JSON.stringify(requestContext),
      this.optionalDate(body.started_at || body.startedAt),
      this.integer(body.duration_ms || body.durationMs, null),
    ) as Promise<Row[]>);
    const response = responseRows[0];
    for (const answer of normalizedAnswers) {
      await this.insertAnswerItem(app.id, form.id, response.id, answer);
    }
    await this.applySystemSideEffects(app, form, answerMap, userId, request, body);
    await this.emitResponseNotification(app, form, response, score);
    return {
      message: String(form.success_title || '提交成功'),
      item: await this.getResponseItem(app.id, form.id, response.id),
    };
  }

  async listResponses(appId: string, formRef: string, query: Record<string, unknown> = {}) {
    const app = await this.ensureAppExists(appId);
    const form = await this.getFormRow(app.id, formRef);
    const page = Math.max(1, this.integer(query.page, 1) || 1);
    const pageSize = Math.min(100, Math.max(1, this.integer(query.page_size || query.pageSize, 20) || 20));
    const [countRows, rows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS count
         FROM app_form_responses
         WHERE app_id = $1::uuid AND form_id = $2::uuid`,
        app.id,
        form.id,
      ) as Promise<Array<{ count: bigint }>>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           r.*,
           u.email AS user_email,
           u.display_name AS user_display_name,
           u.full_name AS user_full_name,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id', a.id,
                 'question_id', a.question_id,
                 'question_key', a.question_key,
                 'question_type', a.question_type,
                 'value_text', a.value_text,
                 'value_number', a.value_number,
                 'value_boolean', a.value_boolean,
                 'value', a.value_json,
                 'option_key', a.option_key,
                 'option_label', a.option_label,
                 'sort_order', a.sort_order
               )
               ORDER BY a.sort_order ASC
             ) FILTER (WHERE a.id IS NOT NULL),
             '[]'::jsonb
           ) AS answers_json
         FROM app_form_responses r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN app_form_answer_items a ON a.response_id = r.id
         WHERE r.app_id = $1::uuid AND r.form_id = $2::uuid
         GROUP BY r.id, u.email, u.display_name, u.full_name
         ORDER BY r.submitted_at DESC
         LIMIT $3 OFFSET $4`,
        app.id,
        form.id,
        pageSize,
        (page - 1) * pageSize,
      ) as Promise<Row[]>),
    ]);
    return {
      total: this.toNumber(countRows[0]?.count),
      page,
      page_size: pageSize,
      items: rows.map((row) => this.serializeResponse(row)),
    };
  }

  async getMetrics(appId: string, formRef: string) {
    const form = this.isUuid(formRef) ? null : undefined;
    const formId = form === undefined ? (await this.getFormRow(appId, formRef)).id : formRef;
    const [overviewRows, npsRows] = await Promise.all([
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*)::bigint AS responses,
           COUNT(DISTINCT user_id)::bigint AS users,
           AVG(score) AS average_score,
           MIN(submitted_at) AS first_submitted_at,
           MAX(submitted_at) AS last_submitted_at
         FROM app_form_responses
         WHERE app_id = $1::uuid AND form_id = $2::uuid`,
        appId,
        formId,
      ) as Promise<Row[]>),
      (this.prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE score >= 9)::bigint AS promoters,
           COUNT(*) FILTER (WHERE score >= 7 AND score < 9)::bigint AS passives,
           COUNT(*) FILTER (WHERE score < 7)::bigint AS detractors,
           COUNT(score)::bigint AS scored
         FROM app_form_responses
         WHERE app_id = $1::uuid AND form_id = $2::uuid
           AND score IS NOT NULL`,
        appId,
        formId,
      ) as Promise<Row[]>),
    ]);
    const overview = overviewRows[0] || {};
    const nps = npsRows[0] || {};
    const scored = this.toNumber(nps.scored);
    const promoters = this.toNumber(nps.promoters);
    const detractors = this.toNumber(nps.detractors);
    return {
      responses: this.toNumber(overview.responses),
      users: this.toNumber(overview.users),
      average_score: overview.average_score === null || overview.average_score === undefined ? null : Number(overview.average_score),
      first_submitted_at: this.toIso(overview.first_submitted_at),
      last_submitted_at: this.toIso(overview.last_submitted_at),
      nps: {
        scored,
        promoters,
        passives: this.toNumber(nps.passives),
        detractors,
        score: scored ? Math.round(((promoters - detractors) / scored) * 100) : null,
      },
    };
  }

  private async ensureDefaultForms(appId: string) {
    const app = await this.ensureAppExists(appId);
    await this.ensureDefaultSourceOptions(app.id);
    await this.upsertSystemForm(app, {
      form_key: 'user_source',
      name: '用户来源',
      form_type: 'SYSTEM_USER_SOURCE',
      title: '你是从哪里知道我们的？',
      subtitle: '',
      submit_label: '保存',
      success_title: '已保存',
      success_message: '感谢反馈。',
      settings: { embedded: true, allow_anonymous: false, replace_user_submission: true, system_key: 'user_source' },
      questions: [
        {
          question_key: 'source_key',
          type: 'source_select',
          title: '来源',
          description: '',
          required: true,
          sort_order: 10,
          options: [],
          validation: {},
          properties: { layout: 'radio' },
        },
        {
          question_key: 'free_text',
          type: 'short_text',
          title: '补充说明',
          description: '',
          required: false,
          sort_order: 20,
          options: [],
          validation: { max_length: 240 },
          properties: { placeholder: '选“其他”时可填写' },
        },
      ],
    });
    await this.upsertSystemForm(app, {
      form_key: 'nps',
      name: 'NPS 打分',
      form_type: 'SYSTEM_NPS',
      title: '你愿意向朋友推荐我们吗？',
      subtitle: '',
      submit_label: '提交',
      success_title: '感谢反馈',
      success_message: '',
      settings: { embedded: true, allow_anonymous: true, system_key: 'nps' },
      questions: [
        {
          question_key: 'score',
          type: 'nps',
          title: '推荐意愿',
          description: '0 代表完全不愿意，10 代表非常愿意。',
          required: true,
          sort_order: 10,
          options: [],
          validation: { min: 0, max: 10 },
          properties: { min_label: '不愿意', max_label: '非常愿意' },
        },
        {
          question_key: 'comment',
          type: 'long_text',
          title: '原因',
          description: '',
          required: false,
          sort_order: 20,
          options: [],
          validation: { max_length: 1000 },
          properties: { placeholder: '可以写下主要原因' },
        },
      ],
    });
    await this.publishSystemFormIfChanged(app, 'user_source');
    await this.publishSystemFormIfChanged(app, 'nps');
  }

  private async upsertSystemForm(app: AppRow, definition: {
    form_key: string;
    name: string;
    form_type: string;
    title: string;
    subtitle: string;
    submit_label: string;
    success_title: string;
    success_message: string;
    settings: Record<string, unknown>;
    questions: Array<Record<string, unknown>>;
  }) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_forms (
         id, app_id, form_key, name, description, form_type, status, title, subtitle,
         submit_label, success_title, success_message, theme_json, settings_json,
         variables_json, endings_json, notification_json, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::text, $3::text, NULL, $4::text, 'ACTIVE',
         $5::text, $6::text, $7::text, $8::text, $9::text, '{}'::jsonb, $10::jsonb,
         '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now()
       )
       ON CONFLICT (app_id, form_key) DO UPDATE
       SET form_type = EXCLUDED.form_type,
           status = CASE WHEN app_forms.status = 'DELETED' THEN 'ACTIVE' ELSE app_forms.status END,
           updated_at = now()
       RETURNING *`,
      app.id,
      definition.form_key,
      definition.name,
      definition.form_type,
      definition.title,
      definition.subtitle,
      definition.submit_label,
      definition.success_title,
      definition.success_message,
      JSON.stringify(definition.settings),
    ) as Promise<FormRow[]>);
    const form = rows[0];
    for (const question of definition.questions) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO app_form_questions (
           id, app_id, form_id, question_key, type, title, description, required, sort_order,
           options_json, validation_json, properties_json, visibility_json, created_at, updated_at
         )
         VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
           $7::boolean, $8::int, $9::jsonb, $10::jsonb, $11::jsonb, '{}'::jsonb, now(), now()
         )
         ON CONFLICT (form_id, question_key) DO NOTHING`,
        app.id,
        form.id,
        question.question_key,
        question.type,
        question.title,
        question.description || '',
        Boolean(question.required),
        Number(question.sort_order || 0),
        JSON.stringify(asArray(question.options)),
        JSON.stringify(asObject(question.validation)),
        JSON.stringify(asObject(question.properties)),
      );
    }
  }

  private async ensureDefaultSourceOptions(appId: string) {
    for (const [key, label, allowFreeText, sortOrder] of DEFAULT_SOURCE_OPTIONS) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO app_acquisition_source_options (app_id, key, label, is_active, allow_free_text, sort_order, metadata_json, created_at, updated_at)
         VALUES ($1::uuid, $2::text, $3::text, true, $4::boolean, $5::int, '{}'::jsonb, now(), now())
         ON CONFLICT (app_id, key) DO NOTHING`,
        appId,
        key,
        label,
        allowFreeText,
        sortOrder,
      );
    }
  }

  private async publishSystemFormIfChanged(app: AppRow, formKey: string) {
    const form = await this.getFormRow(app.id, formKey);
    await this.publishFormRow(app, form, null, { systemOnlyIfChanged: true });
  }

  private async publishFormRow(app: AppRow, form: FormRow, actorUserId?: string | null, options?: { systemOnlyIfChanged?: boolean }) {
    const [questions, rules, actions] = await Promise.all([
      this.loadQuestions(form.id),
      this.loadLogicRules(form.id),
      this.loadActions(form.id),
    ]);
    const manifestDraft = await this.buildManifest(app, form, questions, rules, actions);
    const hash = this.hashManifest(manifestDraft);
    const existingRows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM app_form_versions
       WHERE form_id = $1::uuid AND schema_hash = $2::text
       LIMIT 1`,
      form.id,
      hash,
    ) as Promise<Row[]>);
    if (existingRows[0]) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE app_forms
         SET published_version_id = $3::uuid,
             status = 'ACTIVE',
             updated_at = CASE WHEN published_version_id IS DISTINCT FROM $3::uuid THEN now() ELSE updated_at END
         WHERE app_id = $1::uuid AND id = $2::uuid`,
        app.id,
        form.id,
        existingRows[0].id,
      );
      return existingRows[0];
    }
    if (options?.systemOnlyIfChanged && form.published_version_id) {
      const currentRows = await (this.prisma.$queryRawUnsafe(
        `SELECT schema_hash
         FROM app_form_versions
         WHERE id = $1::uuid
         LIMIT 1`,
        form.published_version_id,
      ) as Promise<Row[]>);
      if (currentRows[0]?.schema_hash === hash) {
        return currentRows[0];
      }
    }
    const maxRows = await (this.prisma.$queryRawUnsafe(
      `SELECT COALESCE(MAX(version), 0)::int AS version
       FROM app_form_versions
       WHERE form_id = $1::uuid`,
      form.id,
    ) as Promise<Array<{ version: number }>>);
    const versionNumber = Number(maxRows[0]?.version || 0) + 1;
    const manifest = {
      ...manifestDraft,
      version: {
        number: versionNumber,
        schema_hash: hash,
        published_at: new Date().toISOString(),
      },
    };
    const rows = await (this.prisma.$queryRawUnsafe(
      `INSERT INTO app_form_versions (
         id, app_id, form_id, version, schema_hash, manifest_json, status,
         published_by_user_id, published_at, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::int, $4::text, $5::jsonb, 'published',
         $6::uuid, now(), now()
       )
       RETURNING *`,
      app.id,
      form.id,
      versionNumber,
      hash,
      JSON.stringify(manifest),
      this.optionalUuid(actorUserId),
    ) as Promise<Row[]>);
    const version = rows[0];
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_forms
       SET published_version_id = $3::uuid,
           status = 'ACTIVE',
           updated_at = now()
       WHERE app_id = $1::uuid AND id = $2::uuid`,
      app.id,
      form.id,
      version.id,
    );
    return version;
  }

  private async buildManifest(app: AppRow, form: FormRow, questions: QuestionRow[], rules: LogicRuleRow[], actions: ActionRow[]) {
    const sourceOptions = form.form_type === 'SYSTEM_USER_SOURCE'
      ? await this.loadSourceOptions(app.id)
      : [];
    const blocks = questions.map((question) => {
      const serialized = this.serializeQuestion(question);
      return {
        id: serialized.id,
        key: serialized.question_key,
        type: serialized.type,
        title: serialized.title,
        description: serialized.description,
        required: serialized.required,
        sort_order: serialized.sort_order,
        options: serialized.type === 'source_select' ? sourceOptions : serialized.options,
        validation: serialized.validation,
        properties: serialized.properties,
        visibility: serialized.visibility,
      };
    });
    return {
      schema: 'opg.app_form.v1',
      app: { id: app.id, slug: app.slug, name: app.name },
      form: {
        id: form.id,
        key: form.form_key,
        type: form.form_type,
        name: form.name,
        title: form.title,
        subtitle: form.subtitle || '',
        description: form.description || '',
        submit_label: form.submit_label || '提交',
        success_title: form.success_title || '提交成功',
        success_message: form.success_message || '',
        theme: this.normalizeTheme(form.theme_json),
        settings: this.normalizeSettings(form.settings_json),
        variables: asObject(form.variables_json),
        endings: asArray(form.endings_json),
      },
      blocks,
      logic: rules.map((rule) => this.serializeLogicRule(rule)),
      actions: actions.map((action) => {
        const item = this.serializeAction(action);
        return {
          id: item.id,
          name: item.name,
          action_type: item.action_type,
          enabled: item.enabled,
          trigger_event: item.trigger_event,
        };
      }),
    };
  }

  private normalizeAnswers(blocks: Record<string, unknown>[], answersPayload: unknown) {
    const byKey = new Map<string, unknown>();
    if (Array.isArray(answersPayload)) {
      answersPayload.forEach((item) => {
        const object = asObject(item);
        const key = String(object.question_key || object.key || object.id || '').trim();
        if (key) byKey.set(key, object.value !== undefined ? object.value : object.answer);
      });
    } else {
      const object = asObject(answersPayload);
      Object.entries(object).forEach(([key, value]) => byKey.set(key, value));
    }

    return blocks
      .filter((block) => String(block.type || '') !== 'statement')
      .map((block, index) => this.normalizeAnswer(block, byKey.get(String(block.key || '').trim()), index))
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  private normalizeAnswer(block: Record<string, unknown>, rawValue: unknown, index: number) {
    const key = String(block.key || '').trim();
    const type = String(block.type || '').trim();
    if (!key || type === 'statement') return null;
    const required = Boolean(block.required);
    const missing = rawValue === undefined || rawValue === null || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0);
    if (missing) {
      if (required) throw new BadRequestException(`缺少必填项：${String(block.title || key)}`);
      return null;
    }
    const options = asArray(block.options).map((item) => asObject(item));
    const base = {
      question_id: String(block.id || '') || null,
      question_key: key,
      question_type: type,
      value_text: null as string | null,
      value_number: null as number | null,
      value_boolean: null as boolean | null,
      value_json: rawValue as unknown,
      option_key: null as string | null,
      option_label: null as string | null,
      sort_order: Number(block.sort_order || index * 10),
    };
    if (['short_text', 'long_text', 'email', 'url', 'phone', 'date', 'hidden'].includes(type)) {
      const text = this.optionalString(rawValue, type === 'long_text' ? 5000 : 1000);
      if (!text && required) throw new BadRequestException(`缺少必填项：${String(block.title || key)}`);
      return { ...base, value_text: text, value_json: text };
    }
    if (['number', 'rating', 'nps', 'opinion_scale'].includes(type)) {
      const number = Number(rawValue);
      if (!Number.isFinite(number)) throw new BadRequestException(`${String(block.title || key)} 必须是数字`);
      const validation = asObject(block.validation);
      const min = validation.min === undefined ? null : Number(validation.min);
      const max = validation.max === undefined ? null : Number(validation.max);
      if (Number.isFinite(min) && number < Number(min)) throw new BadRequestException(`${String(block.title || key)} 低于最小值`);
      if (Number.isFinite(max) && number > Number(max)) throw new BadRequestException(`${String(block.title || key)} 高于最大值`);
      return { ...base, value_number: number, value_json: number };
    }
    if (['boolean', 'consent'].includes(type)) {
      const value = this.boolean(rawValue, false);
      if (required && !value) throw new BadRequestException(`缺少必填项：${String(block.title || key)}`);
      return { ...base, value_boolean: value, value_json: value };
    }
    if (['single_select', 'source_select'].includes(type)) {
      const optionKey = this.normalizeKey(rawValue);
      const option = options.find((item) => String(item.key || '').trim() === optionKey);
      if (!option) throw new BadRequestException(`${String(block.title || key)} 选项不可用`);
      return {
        ...base,
        value_text: optionKey,
        value_json: optionKey,
        option_key: optionKey,
        option_label: this.optionalString(option.label, 240),
      };
    }
    if (type === 'multi_select') {
      const values = asArray(rawValue).map((item) => this.normalizeKey(item)).filter(Boolean);
      if (required && !values.length) throw new BadRequestException(`缺少必填项：${String(block.title || key)}`);
      const labels = values.map((value) => {
        const option = options.find((item) => String(item.key || '').trim() === value);
        if (!option) throw new BadRequestException(`${String(block.title || key)} 选项不可用`);
        return this.optionalString(option.label, 240) || value;
      });
      return { ...base, value_text: values.join(','), value_json: values, option_key: values.join(','), option_label: labels.join(', ') };
    }
    return { ...base, value_text: this.optionalString(rawValue, 2000), value_json: rawValue };
  }

  private async insertAnswerItem(appId: string, formId: string, responseId: string, answer: ReturnType<AppFormsService['normalizeAnswer']> & Record<string, any>) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO app_form_answer_items (
         id, app_id, form_id, response_id, question_id, question_key, question_type,
         value_text, value_number, value_boolean, value_json, option_key, option_label,
         sort_order, created_at
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text,
         $7::text, $8::numeric, $9::boolean, $10::jsonb, $11::text, $12::text, $13::int, now()
       )`,
      appId,
      formId,
      responseId,
      this.optionalUuid(answer.question_id),
      answer.question_key,
      answer.question_type,
      answer.value_text,
      answer.value_number,
      answer.value_boolean,
      JSON.stringify(answer.value_json),
      answer.option_key,
      answer.option_label,
      answer.sort_order,
    );
  }

  private async applySystemSideEffects(
    app: AppRow,
    form: FormRow,
    answers: Map<string, any>,
    userId: string | null,
    request: any,
    body: Record<string, unknown>,
  ) {
    if (form.form_type === 'SYSTEM_USER_SOURCE' && userId) {
      const source = answers.get('source_key');
      if (!source?.option_key) return;
      await this.acquisitionService.submitMySourceByAppSlug(app.slug, userId, {
        source_key: source.option_key,
        free_text: answers.get('free_text')?.value_text || body.free_text,
        utm_source: body.utm_source || asObject(body.hidden).utm_source,
        utm_medium: body.utm_medium || asObject(body.hidden).utm_medium,
        utm_campaign: body.utm_campaign || asObject(body.hidden).utm_campaign,
        referrer: body.referrer || asObject(body.hidden).referrer,
        landing_path: body.landing_path || asObject(body.hidden).landing_path,
        session_id: body.session_id || body.sessionId,
      }, request);
    }
  }

  private async emitResponseNotification(app: AppRow, form: FormRow, response: Row, score: { value: number | null; label: string | null }) {
    await this.adminNotificationsService.emit({
      app_id: app.id,
      event_type: 'form.response.created',
      severity: 'info',
      title: `新表单提交：${form.name}`,
      message: score.value === null ? '收到一条新的表单提交。' : `收到一条新的表单提交，分数 ${score.value}。`,
      source_module: 'app_forms',
      source_id: response.id,
      dedupe_key: '',
      payload: {
        form_id: form.id,
        form_key: form.form_key,
        form_type: form.form_type,
        response_id: response.id,
        score: score.value,
        score_label: score.label,
      },
    });
  }

  private resolveResponseScore(formType: string, answers: Map<string, any>) {
    const scoreAnswer = answers.get('score') || Array.from(answers.values()).find((item) => ['nps', 'rating', 'opinion_scale'].includes(item.question_type));
    if (!scoreAnswer || scoreAnswer.value_number === null || scoreAnswer.value_number === undefined) {
      return { value: null, label: null };
    }
    const value = Number(scoreAnswer.value_number);
    if (formType === 'SYSTEM_NPS' || scoreAnswer.question_type === 'nps') {
      return {
        value,
        label: value >= 9 ? 'promoter' : value >= 7 ? 'passive' : 'detractor',
      };
    }
    return { value, label: null };
  }

  private async resolveOptionalAuthUser(token: string | null, settings: Record<string, unknown>, appSlug: string) {
    if (!token) return null;
    try {
      const user = await this.authService.verifyAccessToken(token);
      if (String(user?.appSlug || '').trim().toLowerCase() !== appSlug.toLowerCase()) {
        throw new UnauthorizedException('token app mismatch');
      }
      return user;
    } catch (error) {
      if (settings.allow_anonymous === false) throw error;
      return null;
    }
  }

  private extractAccessToken(request?: any) {
    const authorization = String(request?.headers?.authorization || '').trim();
    if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim() || null;
    const cookieHeader = String(request?.headers?.cookie || '');
    for (const part of cookieHeader.split(';')) {
      const [rawKey, ...rest] = part.trim().split('=');
      if (!['access_token', 'token'].includes(rawKey)) continue;
      const rawValue = rest.join('=').trim();
      if (!rawValue) continue;
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
    return null;
  }

  private async findIdempotentResponse(appId: string, formId: string, idempotencyKey: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM app_form_responses
       WHERE app_id = $1::uuid AND form_id = $2::uuid AND idempotency_key = $3::text
       LIMIT 1`,
      appId,
      formId,
      idempotencyKey,
    ) as Promise<Row[]>);
    return rows[0] ? this.getResponseItem(appId, formId, rows[0].id) : null;
  }

  private async getResponseItem(appId: string, formId: string, responseId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT
         r.*,
         u.email AS user_email,
         u.display_name AS user_display_name,
         u.full_name AS user_full_name,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', a.id,
               'question_id', a.question_id,
               'question_key', a.question_key,
               'question_type', a.question_type,
               'value_text', a.value_text,
               'value_number', a.value_number,
               'value_boolean', a.value_boolean,
               'value', a.value_json,
               'option_key', a.option_key,
               'option_label', a.option_label,
               'sort_order', a.sort_order
             )
             ORDER BY a.sort_order ASC
           ) FILTER (WHERE a.id IS NOT NULL),
           '[]'::jsonb
         ) AS answers_json
       FROM app_form_responses r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN app_form_answer_items a ON a.response_id = r.id
       WHERE r.app_id = $1::uuid AND r.form_id = $2::uuid AND r.id = $3::uuid
       GROUP BY r.id, u.email, u.display_name, u.full_name
       LIMIT 1`,
      appId,
      formId,
      responseId,
    ) as Promise<Row[]>);
    if (!rows[0]) throw new NotFoundException('Response not found');
    return this.serializeResponse(rows[0]);
  }

  private async resolveAppBySlug(appSlug?: string): Promise<AppRow> {
    const slug = String(appSlug || '').trim().toLowerCase();
    if (!slug || slug === 'api') throw new NotFoundException('App not found');
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, slug, name
       FROM apps
       WHERE slug = $1::text
       UNION ALL
       SELECT a.id, a.slug, a.name
       FROM app_slug_aliases s
       JOIN apps a ON a.id = s.app_id
       WHERE s.slug = $1::text AND s.is_active = true
       LIMIT 1`,
      slug,
    ) as Promise<AppRow[]>);
    if (!rows[0]) throw new NotFoundException('App not found');
    return rows[0];
  }

  private async ensureAppExists(appId: string): Promise<AppRow> {
    const id = String(appId || '').trim();
    if (!id) throw new NotFoundException('App not found');
    const app = await this.prisma.app.findUnique({ where: { id }, select: { id: true, slug: true, name: true } });
    if (!app) throw new NotFoundException('App not found');
    return app;
  }

  private async getFormRow(appId: string, formRef: string): Promise<FormRow> {
    const ref = String(formRef || '').trim();
    if (!ref) throw new NotFoundException('Form not found');
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM app_forms
       WHERE app_id = $1::uuid
         AND deleted_at IS NULL
         AND (${this.isUuid(ref) ? 'id = $2::uuid' : 'form_key = $2::text'})
       LIMIT 1`,
      appId,
      ref,
    ) as Promise<FormRow[]>);
    if (!rows[0]) throw new NotFoundException('Form not found');
    return rows[0];
  }

  private async getQuestionRow(formId: string, questionId: string): Promise<QuestionRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM app_form_questions WHERE form_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      formId,
      questionId,
    ) as Promise<QuestionRow[]>);
    if (!rows[0]) throw new NotFoundException('Question not found');
    return rows[0];
  }

  private async getLogicRuleRow(formId: string, ruleId: string): Promise<LogicRuleRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM app_form_logic_rules WHERE form_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      formId,
      ruleId,
    ) as Promise<LogicRuleRow[]>);
    if (!rows[0]) throw new NotFoundException('Logic rule not found');
    return rows[0];
  }

  private async getActionRow(formId: string, actionId: string): Promise<ActionRow> {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT * FROM app_form_actions WHERE form_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      formId,
      actionId,
    ) as Promise<ActionRow[]>);
    if (!rows[0]) throw new NotFoundException('Action not found');
    return rows[0];
  }

  private async loadQuestions(formId: string) {
    return (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM app_form_questions
       WHERE form_id = $1::uuid
       ORDER BY sort_order ASC, created_at ASC`,
      formId,
    ) as Promise<QuestionRow[]>);
  }

  private async loadLogicRules(formId: string) {
    return (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM app_form_logic_rules
       WHERE form_id = $1::uuid
       ORDER BY sort_order ASC, created_at ASC`,
      formId,
    ) as Promise<LogicRuleRow[]>);
  }

  private async loadActions(formId: string) {
    return (this.prisma.$queryRawUnsafe(
      `SELECT *
       FROM app_form_actions
       WHERE form_id = $1::uuid
       ORDER BY created_at ASC`,
      formId,
    ) as Promise<ActionRow[]>);
  }

  private async loadVersions(formId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT id, app_id, form_id, version, schema_hash, status, published_by_user_id, published_at, created_at
       FROM app_form_versions
       WHERE form_id = $1::uuid
       ORDER BY version DESC
       LIMIT 20`,
      formId,
    ) as Promise<Row[]>);
    return rows.map((row) => this.serializeVersion(row));
  }

  private async loadSourceOptions(appId: string) {
    const result = await this.acquisitionService.listSourceOptionsByAppId(appId, { activeOnly: true });
    return (result.items || []).map((item: any) => ({
      key: item.key,
      label: item.label,
      allow_free_text: Boolean(item.allow_free_text),
      sort_order: Number(item.sort_order || 0),
    }));
  }

  private async nextQuestionSortOrder(formId: string) {
    const rows = await (this.prisma.$queryRawUnsafe(
      `SELECT COALESCE(MAX(sort_order), 0)::int + 10 AS sort_order
       FROM app_form_questions
       WHERE form_id = $1::uuid`,
      formId,
    ) as Promise<Array<{ sort_order: number }>>);
    return Number(rows[0]?.sort_order || 10);
  }

  private async touchForm(formId: string) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE app_forms SET updated_at = now() WHERE id = $1::uuid`,
      formId,
    );
  }

  private buildRequestContext(request?: any) {
    return {
      user_agent: this.optionalString(request?.headers?.['user-agent'], 512),
      ip_hash: this.hashIp(this.pickIpAddress(request)),
      referrer: this.optionalString(request?.headers?.referer || request?.headers?.referrer, 2000),
      origin: this.optionalString(request?.headers?.origin, 500),
    };
  }

  private pickIpAddress(request?: any) {
    const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim();
    return forwarded || String(request?.ip || request?.socket?.remoteAddress || '').trim();
  }

  private hashIp(value: string) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return createHash('sha256').update(raw).digest('hex');
  }

  private hashManifest(manifest: unknown) {
    return createHash('sha256').update(this.stableStringify(manifest), 'utf8').digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${this.stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private normalizeQuestionType(value: unknown) {
    const type = String(value || '').trim().toLowerCase();
    if (!QUESTION_TYPES.has(type)) {
      throw new BadRequestException('Unsupported question type');
    }
    return type;
  }

  private normalizeOptions(value: unknown) {
    return asArray(value).slice(0, 100).map((item, index) => {
      const object = asObject(item);
      const label = this.requiredString(object.label, 'option.label', 240);
      const key = this.normalizeKey(object.key || label || `option_${index + 1}`);
      return {
        key,
        label,
        allow_free_text: this.boolean(object.allow_free_text || object.allowFreeText, false),
        sort_order: this.integer(object.sort_order || object.sortOrder, (index + 1) * 10),
      };
    });
  }

  private normalizeTheme(value: unknown) {
    const object = asObject(value);
    return {
      primary_color: this.optionalString(object.primary_color || object.primaryColor, 32) || '#2563eb',
      background_color: this.optionalString(object.background_color || object.backgroundColor, 32) || '#ffffff',
      text_color: this.optionalString(object.text_color || object.textColor, 32) || '#111827',
      radius: this.optionalString(object.radius, 24) || '8px',
      ...object,
    };
  }

  private normalizeSettings(value: unknown) {
    const object = asObject(value);
    return {
      embedded: object.embedded === undefined ? true : this.boolean(object.embedded, true),
      allow_anonymous: object.allow_anonymous === undefined && object.allowAnonymous === undefined
        ? true
        : this.boolean(object.allow_anonymous ?? object.allowAnonymous, true),
      ...object,
    };
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    const normalized = this.optionalString(value, maxLength);
    if (!normalized) throw new BadRequestException(`${field} is required`);
    return normalized;
  }

  private optionalString(value: unknown, maxLength: number) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    return normalized.slice(0, maxLength);
  }

  private normalizeKey(value: unknown) {
    const raw = String(value || '').trim().toLowerCase();
    const normalized = raw
      .replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    if (!normalized) throw new BadRequestException('key is required');
    return normalized;
  }

  private optionalUuid(value: unknown) {
    const raw = String(value || '').trim();
    return this.isUuid(raw) ? raw : null;
  }

  private isUuid(value: unknown) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
  }

  private boolean(value: unknown, fallback: boolean) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'off'].includes(raw)) return false;
    return fallback;
  }

  private integer(value: unknown, fallback: number | null) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.floor(parsed);
  }

  private optionalDate(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  private toNumber(value: unknown) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toIso(value: unknown) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }

  private serializeFormListItem(row: FormRow & Row, app: AppRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      form_key: row.form_key,
      name: row.name,
      description: row.description || '',
      form_type: row.form_type,
      status: row.status,
      title: row.title,
      subtitle: row.subtitle || '',
      submit_label: row.submit_label,
      published_version_id: row.published_version_id,
      published_version: row.published_version || null,
      published_at: this.toIso(row.published_at),
      response_count: this.toNumber(row.response_count),
      last_response_at: this.toIso(row.last_response_at),
      hosted_path: `/${app.slug}/forms/${row.form_key}`,
      updated_at: this.toIso(row.updated_at),
      created_at: this.toIso(row.created_at),
    };
  }

  private serializeFormDetail(
    form: FormRow,
    app: AppRow,
    questions: QuestionRow[],
    rules: LogicRuleRow[],
    actions: ActionRow[],
    versions: unknown[],
    metrics: unknown,
  ) {
    return {
      ...this.serializeFormListItem(form as FormRow & Row, app),
      success_title: form.success_title,
      success_message: form.success_message || '',
      theme: this.normalizeTheme(form.theme_json),
      settings: this.normalizeSettings(form.settings_json),
      variables: asObject(form.variables_json),
      endings: asArray(form.endings_json),
      notification: asObject(form.notification_json),
      questions: questions.map((row) => this.serializeQuestion(row)),
      logic_rules: rules.map((row) => this.serializeLogicRule(row)),
      actions: actions.map((row) => this.serializeAction(row)),
      versions,
      metrics,
    };
  }

  private serializeQuestion(row: QuestionRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      form_id: row.form_id,
      question_key: row.question_key,
      type: row.type,
      title: row.title,
      description: row.description || '',
      required: Boolean(row.required),
      sort_order: Number(row.sort_order || 0),
      options: asArray(row.options_json),
      validation: asObject(row.validation_json),
      properties: asObject(row.properties_json),
      visibility: asObject(row.visibility_json),
      created_at: this.toIso(row.created_at),
      updated_at: this.toIso(row.updated_at),
    };
  }

  private serializeLogicRule(row: LogicRuleRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      form_id: row.form_id,
      name: row.name,
      rule_type: row.rule_type,
      enabled: Boolean(row.enabled),
      sort_order: Number(row.sort_order || 0),
      conditions: asArray(row.conditions_json),
      actions: asArray(row.actions_json),
      created_at: this.toIso(row.created_at),
      updated_at: this.toIso(row.updated_at),
    };
  }

  private serializeAction(row: ActionRow) {
    return {
      id: row.id,
      app_id: row.app_id,
      form_id: row.form_id,
      name: row.name,
      action_type: row.action_type,
      enabled: Boolean(row.enabled),
      trigger_event: row.trigger_event,
      run_async: Boolean(row.run_async),
      filters: asArray(row.filters_json),
      config: asObject(row.config_json),
      created_at: this.toIso(row.created_at),
      updated_at: this.toIso(row.updated_at),
    };
  }

  private serializeVersion(row: Row) {
    return {
      id: row.id,
      app_id: row.app_id,
      form_id: row.form_id,
      version: Number(row.version || 0),
      schema_hash: row.schema_hash,
      status: row.status,
      published_by_user_id: row.published_by_user_id || null,
      published_at: this.toIso(row.published_at),
      created_at: this.toIso(row.created_at),
    };
  }

  private serializeResponse(row: Row) {
    return {
      id: row.id,
      app_id: row.app_id,
      form_id: row.form_id,
      form_version_id: row.form_version_id || null,
      user_id: row.user_id || null,
      user_email: row.user_email || null,
      user_display_name: row.user_display_name || row.user_full_name || row.user_email || null,
      respondent_key: row.respondent_key || null,
      session_id: row.session_id || null,
      status: row.status,
      score: row.score === null || row.score === undefined ? null : Number(row.score),
      score_label: row.score_label || null,
      hidden: asObject(row.hidden_json),
      metadata: asObject(row.metadata_json),
      request_context: asObject(row.request_context_json),
      answers: asArray(row.answers_json),
      submitted_at: this.toIso(row.submitted_at),
      created_at: this.toIso(row.created_at),
    };
  }
}
