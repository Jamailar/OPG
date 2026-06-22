import { useEffect, useMemo, useState } from 'react';
import {
  PlatformAcquisitionSourceOption,
  PlatformAppFormItem,
  PlatformAppFormOption,
  PlatformAppFormQuestion,
  PlatformAppFormQuestionType,
  PlatformAppFormResponseItem,
  platformApi,
} from '@/lib/api';
import { pickApiErrorMessage } from '@/lib/api-response';

type Message = { type: 'success' | 'error'; text: string } | null;
type FormPanelView = 'list' | 'detail' | 'edit';

type FormDraft = {
  name: string;
  form_key: string;
  title: string;
  subtitle: string;
  submit_label: string;
  success_title: string;
  success_message: string;
};

type QuestionEdit = {
  question_key: string;
  type: PlatformAppFormQuestionType;
  title: string;
  description: string;
  required: boolean;
  option_lines: string;
};

type SourceOptionEdit = {
  key: string;
  label: string;
  sort_order: string;
  allow_free_text: boolean;
  is_active: boolean;
};

const QUESTION_TYPES: Array<{ value: PlatformAppFormQuestionType; label: string; options?: boolean }> = [
  { value: 'short_text', label: '短文本' },
  { value: 'long_text', label: '长文本' },
  { value: 'email', label: '邮箱' },
  { value: 'phone', label: '手机号' },
  { value: 'url', label: '链接' },
  { value: 'number', label: '数字' },
  { value: 'single_select', label: '单选', options: true },
  { value: 'multi_select', label: '多选', options: true },
  { value: 'rating', label: '评分' },
  { value: 'nps', label: 'NPS' },
  { value: 'opinion_scale', label: '意见量表' },
  { value: 'boolean', label: '是/否' },
  { value: 'consent', label: '同意勾选' },
  { value: 'date', label: '日期' },
  { value: 'statement', label: '说明文字' },
  { value: 'hidden', label: '隐藏字段' },
];

const EMPTY_FORM_DRAFT: FormDraft = {
  name: '',
  form_key: '',
  title: '',
  subtitle: '',
  submit_label: '提交',
  success_title: '提交成功',
  success_message: '',
};

const EMPTY_QUESTION_DRAFT: QuestionEdit = {
  question_key: '',
  type: 'short_text',
  title: '',
  description: '',
  required: false,
  option_lines: '',
};

const EMPTY_SOURCE_OPTION: SourceOptionEdit = {
  key: '',
  label: '',
  sort_order: '100',
  allow_free_text: false,
  is_active: true,
};

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formTypeLabel(type?: string) {
  if (type === 'SYSTEM_USER_SOURCE') return '用户来源';
  if (type === 'SYSTEM_NPS') return 'NPS 打分';
  if (type === 'CUSTOM') return '自定义表单';
  return '表单';
}

function formStatusLabel(status?: string) {
  if (status === 'ACTIVE') return '已启用';
  if (status === 'DRAFT') return '草稿';
  if (status === 'DELETED') return '已删除';
  return status || '-';
}

function buildFormDraft(form: PlatformAppFormItem | null): FormDraft {
  if (!form) return EMPTY_FORM_DRAFT;
  return {
    name: form.name || '',
    form_key: form.form_key || '',
    title: form.title || '',
    subtitle: form.subtitle || '',
    submit_label: form.submit_label || '提交',
    success_title: form.success_title || '提交成功',
    success_message: form.success_message || '',
  };
}

function optionsToLines(options?: PlatformAppFormOption[]) {
  return (options || []).map((item) => `${item.key}|${item.label}`).join('\n');
}

function parseOptionLines(value: string): PlatformAppFormOption[] {
  const options: PlatformAppFormOption[] = [];
  value.split('\n').forEach((line) => {
    const raw = line.trim();
    if (!raw) return;
    const [keyPart, ...labelParts] = raw.split('|');
    const label = (labelParts.join('|') || keyPart).trim();
    const key = keyPart.trim();
    if (!key || !label) return;
    options.push({ key, label, sort_order: (options.length + 1) * 10 });
  });
  return options;
}

function buildQuestionEdit(question: PlatformAppFormQuestion): QuestionEdit {
  return {
    question_key: question.question_key,
    type: question.type,
    title: question.title,
    description: question.description || '',
    required: question.required,
    option_lines: optionsToLines(question.options),
  };
}

function answerValue(answer: Record<string, unknown>) {
  if (answer.value_text) return String(answer.value_text);
  if (answer.value_number !== undefined && answer.value_number !== null) return String(answer.value_number);
  if (answer.value_boolean !== undefined && answer.value_boolean !== null) return answer.value_boolean ? '是' : '否';
  if (Array.isArray(answer.value)) return answer.value.join(', ');
  if (answer.value !== undefined && answer.value !== null) return String(answer.value);
  return '-';
}

function isOptionQuestion(type: PlatformAppFormQuestionType) {
  return QUESTION_TYPES.find((item) => item.value === type)?.options === true;
}

export default function TenantFormsPanel({ appId, canWrite }: { appId: string; canWrite: boolean }) {
  const [view, setView] = useState<FormPanelView>('list');
  const [forms, setForms] = useState<PlatformAppFormItem[]>([]);
  const [selectedFormId, setSelectedFormId] = useState('');
  const [selectedForm, setSelectedForm] = useState<PlatformAppFormItem | null>(null);
  const [responses, setResponses] = useState<PlatformAppFormResponseItem[]>([]);
  const [responsesTotal, setResponsesTotal] = useState(0);
  const [sourceOptions, setSourceOptions] = useState<PlatformAcquisitionSourceOption[]>([]);
  const [sourceEdits, setSourceEdits] = useState<Record<string, SourceOptionEdit>>({});
  const [formDraft, setFormDraft] = useState<FormDraft>(EMPTY_FORM_DRAFT);
  const [newForm, setNewForm] = useState({ name: '', form_key: '' });
  const [questionDraft, setQuestionDraft] = useState<QuestionEdit>(EMPTY_QUESTION_DRAFT);
  const [questionEdits, setQuestionEdits] = useState<Record<string, QuestionEdit>>({});
  const [sourceOptionDraft, setSourceOptionDraft] = useState<SourceOptionEdit>(EMPTY_SOURCE_OPTION);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const hostedUrl = useMemo(() => {
    if (!selectedForm?.hosted_path || typeof window === 'undefined') return '';
    return `${window.location.origin}${selectedForm.hosted_path}`;
  }, [selectedForm?.hosted_path]);

  const loadForms = async (preferredId?: string | null) => {
    setLoading(true);
    try {
      const result = await platformApi.listAppForms(appId);
      const items = result.items || [];
      setForms(items);
      const requestedId = preferredId === null ? '' : preferredId || selectedFormId;
      const nextId = requestedId && items.some((item) => item.id === requestedId) ? requestedId : '';
      setSelectedFormId(nextId);
      if (!nextId) setSelectedForm(null);
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '表单列表加载失败') });
    } finally {
      setLoading(false);
    }
  };

  const loadSelectedForm = async (formId: string) => {
    if (!formId) return;
    setLoading(true);
    try {
      const [detail, responseResult] = await Promise.all([
        platformApi.getAppForm(appId, formId),
        platformApi.listAppFormResponses(appId, formId, { page: 1, page_size: 8 }),
      ]);
      const item = detail.item;
      setSelectedForm(item);
      setFormDraft(buildFormDraft(item));
      setQuestionEdits(Object.fromEntries((item.questions || []).map((question) => [question.id, buildQuestionEdit(question)])));
      setResponses(responseResult.items || []);
      setResponsesTotal(responseResult.total || 0);
      if (item.form_type === 'SYSTEM_USER_SOURCE') {
        const sourceResult = await platformApi.listAcquisitionSourceOptions(appId);
        setSourceOptions(sourceResult.items || []);
        setSourceEdits(Object.fromEntries((sourceResult.items || []).map((option) => [option.id, {
          key: option.key,
          label: option.label,
          sort_order: String(option.sort_order || 0),
          allow_free_text: option.allow_free_text,
          is_active: option.is_active,
        }])));
      } else {
        setSourceOptions([]);
        setSourceEdits({});
      }
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '表单详情加载失败') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setView('list');
    setSelectedFormId('');
    setSelectedForm(null);
    setResponses([]);
    setResponsesTotal(0);
    void loadForms(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  useEffect(() => {
    if (selectedFormId) void loadSelectedForm(selectedFormId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFormId]);

  const createForm = async () => {
    if (!newForm.name.trim()) {
      setMessage({ type: 'error', text: '表单名称不能为空' });
      return;
    }
    setSaving(true);
    try {
      const result = await platformApi.createAppForm(appId, {
        name: newForm.name.trim(),
        form_key: newForm.form_key.trim() || undefined,
        title: newForm.name.trim(),
      });
      setNewForm({ name: '', form_key: '' });
      setMessage({ type: 'success', text: '表单已创建' });
      await loadForms(result.item.id);
      setView('edit');
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '创建表单失败') });
    } finally {
      setSaving(false);
    }
  };

  const saveForm = async () => {
    if (!selectedForm) return;
    setSaving(true);
    try {
      const result = await platformApi.updateAppForm(appId, selectedForm.id, {
        name: formDraft.name,
        form_key: formDraft.form_key,
        title: formDraft.title,
        subtitle: formDraft.subtitle,
        submit_label: formDraft.submit_label,
        success_title: formDraft.success_title,
        success_message: formDraft.success_message,
      });
      setSelectedForm(result.item);
      setFormDraft(buildFormDraft(result.item));
      setMessage({ type: 'success', text: '表单已保存' });
      await loadForms(result.item.id);
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存表单失败') });
    } finally {
      setSaving(false);
    }
  };

  const publishForm = async () => {
    if (!selectedForm) return;
    setSaving(true);
    try {
      await platformApi.publishAppForm(appId, selectedForm.id);
      setMessage({ type: 'success', text: '表单已发布' });
      await loadForms(selectedForm.id);
      await loadSelectedForm(selectedForm.id);
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '发布失败') });
    } finally {
      setSaving(false);
    }
  };

  const addQuestion = async () => {
    if (!selectedForm || !questionDraft.title.trim()) {
      setMessage({ type: 'error', text: '问题标题不能为空' });
      return;
    }
    setSaving(true);
    try {
      await platformApi.createAppFormQuestion(appId, selectedForm.id, {
        question_key: questionDraft.question_key.trim() || undefined,
        type: questionDraft.type,
        title: questionDraft.title.trim(),
        description: questionDraft.description.trim(),
        required: questionDraft.required,
        options: isOptionQuestion(questionDraft.type) ? parseOptionLines(questionDraft.option_lines) : [],
      });
      setQuestionDraft(EMPTY_QUESTION_DRAFT);
      setMessage({ type: 'success', text: '问题已添加' });
      await loadSelectedForm(selectedForm.id);
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '添加问题失败') });
    } finally {
      setSaving(false);
    }
  };

  const saveQuestion = async (question: PlatformAppFormQuestion) => {
    if (!selectedForm) return;
    const draft = questionEdits[question.id];
    if (!draft?.title.trim()) {
      setMessage({ type: 'error', text: '问题标题不能为空' });
      return;
    }
    setSaving(true);
    try {
      await platformApi.updateAppFormQuestion(appId, selectedForm.id, question.id, {
        question_key: draft.question_key,
        type: draft.type,
        title: draft.title,
        description: draft.description,
        required: draft.required,
        options: isOptionQuestion(draft.type) ? parseOptionLines(draft.option_lines) : [],
      });
      setMessage({ type: 'success', text: '问题已保存' });
      await loadSelectedForm(selectedForm.id);
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存问题失败') });
    } finally {
      setSaving(false);
    }
  };

  const deleteQuestion = async (question: PlatformAppFormQuestion) => {
    if (!selectedForm) return;
    setSaving(true);
    try {
      await platformApi.deleteAppFormQuestion(appId, selectedForm.id, question.id);
      setMessage({ type: 'success', text: '问题已删除' });
      await loadSelectedForm(selectedForm.id);
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除问题失败') });
    } finally {
      setSaving(false);
    }
  };

  const moveQuestion = async (questionId: string, direction: -1 | 1) => {
    if (!selectedForm?.questions) return;
    const ids = selectedForm.questions.map((question) => question.id);
    const index = ids.indexOf(questionId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    const next = [...ids];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    setSaving(true);
    try {
      await platformApi.reorderAppFormQuestions(appId, selectedForm.id, next);
      await loadSelectedForm(selectedForm.id);
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '排序失败') });
    } finally {
      setSaving(false);
    }
  };

  const saveSourceOption = async (option: PlatformAcquisitionSourceOption) => {
    const edit = sourceEdits[option.id];
    if (!edit) return;
    setSaving(true);
    try {
      await platformApi.updateAcquisitionSourceOption(appId, option.id, {
        key: edit.key,
        label: edit.label,
        sort_order: Number(edit.sort_order || 0),
        allow_free_text: edit.allow_free_text,
        is_active: edit.is_active,
      });
      if (selectedForm) await loadSelectedForm(selectedForm.id);
      setMessage({ type: 'success', text: '来源选项已保存' });
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '保存来源选项失败') });
    } finally {
      setSaving(false);
    }
  };

  const createSourceOption = async () => {
    if (!sourceOptionDraft.key.trim() || !sourceOptionDraft.label.trim()) {
      setMessage({ type: 'error', text: '来源标识和名称不能为空' });
      return;
    }
    setSaving(true);
    try {
      await platformApi.createAcquisitionSourceOption(appId, {
        key: sourceOptionDraft.key,
        label: sourceOptionDraft.label,
        sort_order: Number(sourceOptionDraft.sort_order || 0),
        allow_free_text: sourceOptionDraft.allow_free_text,
        is_active: sourceOptionDraft.is_active,
      });
      setSourceOptionDraft(EMPTY_SOURCE_OPTION);
      if (selectedForm) await loadSelectedForm(selectedForm.id);
      setMessage({ type: 'success', text: '来源选项已新增' });
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '新增来源选项失败') });
    } finally {
      setSaving(false);
    }
  };

  const deleteSourceOption = async (option: PlatformAcquisitionSourceOption) => {
    setSaving(true);
    try {
      await platformApi.deleteAcquisitionSourceOption(appId, option.id);
      if (selectedForm) await loadSelectedForm(selectedForm.id);
      setMessage({ type: 'success', text: '来源选项已删除' });
    } catch (error) {
      setMessage({ type: 'error', text: pickApiErrorMessage(error, '删除来源选项失败') });
    } finally {
      setSaving(false);
    }
  };

  const openDetail = (formId: string) => {
    setSelectedFormId(formId);
    setView('detail');
  };

  const backToList = () => {
    setView('list');
    setSelectedFormId('');
    setSelectedForm(null);
    setResponses([]);
    setResponsesTotal(0);
  };

  const questionOptions = (question: PlatformAppFormQuestion) => {
    if (question.type === 'source_select') {
      return sourceOptions
        .filter((option) => option.is_active)
        .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0))
        .map((option) => ({ key: option.key, label: option.label }));
    }
    return question.options || [];
  };

  const answerLabel = (answer: Record<string, unknown>) => {
    const key = String(answer.question_key || '');
    const question = selectedForm?.questions?.find((item) => item.question_key === key);
    return question?.title || key || '答案';
  };

  const renderPreviewControl = (question: PlatformAppFormQuestion) => {
    const options = questionOptions(question);
    if (question.type === 'statement') {
      return null;
    }
    if (question.type === 'long_text') {
      return <textarea rows={3} disabled placeholder="长文本答案" />;
    }
    if (question.type === 'single_select' || question.type === 'source_select') {
      return (
        <select disabled defaultValue="">
          <option value="">请选择</option>
          {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
      );
    }
    if (question.type === 'multi_select') {
      return (
        <div className="form-preview-options">
          {options.map((option) => (
            <label key={option.key}><input type="checkbox" disabled />{option.label}</label>
          ))}
        </div>
      );
    }
    if (question.type === 'nps') {
      return (
        <div className="form-preview-scale">
          {Array.from({ length: 11 }).map((_, index) => <span key={index}>{index}</span>)}
        </div>
      );
    }
    if (question.type === 'boolean' || question.type === 'consent') {
      return <label className="form-preview-check"><input type="checkbox" disabled />是</label>;
    }
    if (question.type === 'rating' || question.type === 'opinion_scale' || question.type === 'number') {
      return <input type="number" disabled placeholder="数字" />;
    }
    if (question.type === 'date') {
      return <input type="date" disabled />;
    }
    return <input type={question.type === 'email' ? 'email' : question.type === 'url' ? 'url' : 'text'} disabled placeholder="短文本答案" />;
  };

  const renderFormPreview = () => {
    if (!selectedForm) return null;
    const questions = (selectedForm.questions || []).filter((question) => question.type !== 'hidden');
    return (
      <div className="form-preview-shell">
        <div className="form-preview-head">
          <h4>{selectedForm.title || selectedForm.name}</h4>
          {selectedForm.subtitle ? <p>{selectedForm.subtitle}</p> : null}
        </div>
        <div className="form-preview-fields">
          {questions.map((question) => (
            <div className="form-preview-field" key={question.id}>
              <label>{question.title}{question.required ? <span>*</span> : null}</label>
              {question.description ? <small>{question.description}</small> : null}
              {renderPreviewControl(question)}
            </div>
          ))}
          {!questions.length ? <div className="loading">暂无问题</div> : null}
        </div>
        <button className="btn btn-sm" type="button" disabled>{selectedForm.submit_label || '提交'}</button>
      </div>
    );
  };

  const renderQuestionEdit = (question: PlatformAppFormQuestion, index: number) => {
    const edit = questionEdits[question.id] || buildQuestionEdit(question);
    return (
      <div className="form-builder-question" key={question.id}>
        <div className="form-builder-question-head">
          <span>{index + 1}</span>
          <input
            value={edit.title}
            onChange={(event) => setQuestionEdits((prev) => ({ ...prev, [question.id]: { ...edit, title: event.target.value } }))}
            disabled={!canWrite || saving}
          />
          <select
            value={edit.type}
            onChange={(event) => setQuestionEdits((prev) => ({ ...prev, [question.id]: { ...edit, type: event.target.value as PlatformAppFormQuestionType } }))}
            disabled={!canWrite || saving || question.type === 'source_select'}
          >
            {QUESTION_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </div>
        <div className="tenant-feedback-filter-row form-builder-question-grid">
          <label>
            <span>字段标识</span>
            <input
              value={edit.question_key}
              onChange={(event) => setQuestionEdits((prev) => ({ ...prev, [question.id]: { ...edit, question_key: event.target.value } }))}
              disabled={!canWrite || saving || question.type === 'source_select'}
            />
          </label>
          <label>
            <span>说明</span>
            <input
              value={edit.description}
              onChange={(event) => setQuestionEdits((prev) => ({ ...prev, [question.id]: { ...edit, description: event.target.value } }))}
              disabled={!canWrite || saving}
            />
          </label>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={edit.required}
              onChange={(event) => setQuestionEdits((prev) => ({ ...prev, [question.id]: { ...edit, required: event.target.checked } }))}
              disabled={!canWrite || saving}
            />
            必填
          </label>
        </div>
        {isOptionQuestion(edit.type) && (
          <label className="form-builder-option-lines">
            <span>选项</span>
            <textarea
              rows={4}
              value={edit.option_lines}
              placeholder={'字段标识|显示文案\nother|其他'}
              onChange={(event) => setQuestionEdits((prev) => ({ ...prev, [question.id]: { ...edit, option_lines: event.target.value } }))}
              disabled={!canWrite || saving}
            />
          </label>
        )}
        <div className="form-builder-question-actions">
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void moveQuestion(question.id, -1)} disabled={!canWrite || saving || index === 0}>上移</button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void moveQuestion(question.id, 1)} disabled={!canWrite || saving || index >= (selectedForm?.questions?.length || 0) - 1}>下移</button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void saveQuestion(question)} disabled={!canWrite || saving}>保存</button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void deleteQuestion(question)} disabled={!canWrite || saving || question.type === 'source_select'}>删除</button>
        </div>
      </div>
    );
  };

  if (view === 'detail') {
    return (
      <div className="tenant-forms-page">
        {message && <div className={`alert ${message.type}`}>{message.text}</div>}
        {!selectedForm ? (
          <div className="loading">加载中...</div>
        ) : (
          <>
            <div className="platform-section-head forms-page-head">
              <div>
                <button className="btn btn-secondary btn-sm" type="button" onClick={backToList}>返回</button>
                <h3>{selectedForm.name}</h3>
                <p>{formTypeLabel(selectedForm.form_type)} · {formStatusLabel(selectedForm.status)} · {selectedForm.published_version ? `v${selectedForm.published_version}` : '未发布'}</p>
              </div>
              <div className="tenant-card-actions">
                {hostedUrl ? <a className="btn btn-secondary btn-sm" href={hostedUrl} target="_blank" rel="noreferrer">打开</a> : null}
                {canWrite ? <button className="btn btn-sm" type="button" onClick={() => setView('edit')}>编辑</button> : null}
              </div>
            </div>

            <div className="tenant-feedback-summary form-metric-summary">
              <div className="tenant-feedback-summary-card">
                <span>提交</span>
                <strong>{selectedForm.metrics?.responses || selectedForm.response_count || 0}</strong>
              </div>
              <div className="tenant-feedback-summary-card">
                <span>用户</span>
                <strong>{selectedForm.metrics?.users || 0}</strong>
              </div>
              <div className="tenant-feedback-summary-card">
                <span>NPS</span>
                <strong>{selectedForm.metrics?.nps?.score ?? '-'}</strong>
              </div>
            </div>

            <section className="form-builder-section">
              <div className="platform-section-head">
                <div>
                  <h4>提交数据</h4>
                  <p>{responsesTotal} 条</p>
                </div>
              </div>
              <div className="form-response-table-wrap">
                <table className="form-response-table">
                  <thead>
                    <tr>
                      <th>提交人</th>
                      <th>答案</th>
                      <th>分数</th>
                      <th>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {responses.map((response) => (
                      <tr key={response.id}>
                        <td>{response.user_display_name || response.user_email || response.respondent_key || '匿名'}</td>
                        <td>{(response.answers || []).slice(0, 4).map((answer) => `${answerLabel(answer)}：${answerValue(answer)}`).join(' · ') || '-'}</td>
                        <td>{response.score ?? '-'}</td>
                        <td>{formatDateTime(response.submitted_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!responses.length ? <div className="loading">暂无提交记录</div> : null}
              </div>
            </section>

            <section className="form-builder-section">
              <div className="platform-section-head">
                <div>
                  <h4>表单预览</h4>
                  <p>{selectedForm.questions?.length || 0} 个问题</p>
                </div>
              </div>
              {renderFormPreview()}
            </section>
          </>
        )}
      </div>
    );
  }

  if (view === 'edit') {
    return (
      <div className="tenant-forms-page">
        {message && <div className={`alert ${message.type}`}>{message.text}</div>}
        {!selectedForm ? (
          <div className="loading">加载中...</div>
        ) : (
          <>
            <div className="platform-section-head forms-page-head">
              <div>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setView('detail')}>返回</button>
                <h3>编辑：{selectedForm.name}</h3>
                <p>{formTypeLabel(selectedForm.form_type)} · {formStatusLabel(selectedForm.status)}</p>
              </div>
              <div className="tenant-card-actions">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => void publishForm()} disabled={!canWrite || saving}>发布</button>
                <button className="btn btn-sm" type="button" onClick={() => void saveForm()} disabled={!canWrite || saving}>保存</button>
              </div>
            </div>

            <section className="form-builder-section">
              <div className="platform-section-head">
                <div>
                  <h4>基础信息</h4>
                </div>
              </div>
              <div className="tenant-feedback-filter-row form-editor-grid">
                <label>
                  <span>名称</span>
                  <input value={formDraft.name} onChange={(event) => setFormDraft((prev) => ({ ...prev, name: event.target.value }))} disabled={!canWrite || saving} />
                </label>
                <label>
                  <span>表单标识</span>
                  <input value={formDraft.form_key} onChange={(event) => setFormDraft((prev) => ({ ...prev, form_key: event.target.value }))} disabled={!canWrite || saving || selectedForm.form_type !== 'CUSTOM'} />
                </label>
                <label>
                  <span>标题</span>
                  <input value={formDraft.title} onChange={(event) => setFormDraft((prev) => ({ ...prev, title: event.target.value }))} disabled={!canWrite || saving} />
                </label>
                <label>
                  <span>副标题</span>
                  <input value={formDraft.subtitle} onChange={(event) => setFormDraft((prev) => ({ ...prev, subtitle: event.target.value }))} disabled={!canWrite || saving} />
                </label>
                <label>
                  <span>按钮</span>
                  <input value={formDraft.submit_label} onChange={(event) => setFormDraft((prev) => ({ ...prev, submit_label: event.target.value }))} disabled={!canWrite || saving} />
                </label>
                <label>
                  <span>成功文案</span>
                  <input value={formDraft.success_title} onChange={(event) => setFormDraft((prev) => ({ ...prev, success_title: event.target.value }))} disabled={!canWrite || saving} />
                </label>
              </div>
            </section>

            {selectedForm.form_type === 'SYSTEM_USER_SOURCE' && (
              <section className="form-builder-section">
                <div className="platform-section-head">
                  <div>
                    <h4>来源选项</h4>
                    <p>{sourceOptions.length} 个选项</p>
                  </div>
                </div>
                <div className="form-source-options">
                  {sourceOptions.map((option) => {
                    const edit = sourceEdits[option.id] || {
                      key: option.key,
                      label: option.label,
                      sort_order: String(option.sort_order || 0),
                      allow_free_text: option.allow_free_text,
                      is_active: option.is_active,
                    };
                    return (
                      <div className="form-source-option-row" key={option.id}>
                        <input value={edit.key} onChange={(event) => setSourceEdits((prev) => ({ ...prev, [option.id]: { ...edit, key: event.target.value } }))} disabled={!canWrite || saving} />
                        <input value={edit.label} onChange={(event) => setSourceEdits((prev) => ({ ...prev, [option.id]: { ...edit, label: event.target.value } }))} disabled={!canWrite || saving} />
                        <input value={edit.sort_order} onChange={(event) => setSourceEdits((prev) => ({ ...prev, [option.id]: { ...edit, sort_order: event.target.value } }))} disabled={!canWrite || saving} />
                        <label><input type="checkbox" checked={edit.is_active} onChange={(event) => setSourceEdits((prev) => ({ ...prev, [option.id]: { ...edit, is_active: event.target.checked } }))} disabled={!canWrite || saving} />启用</label>
                        <label><input type="checkbox" checked={edit.allow_free_text} onChange={(event) => setSourceEdits((prev) => ({ ...prev, [option.id]: { ...edit, allow_free_text: event.target.checked } }))} disabled={!canWrite || saving} />补充</label>
                        <button className="btn btn-secondary btn-xs" type="button" onClick={() => void saveSourceOption(option)} disabled={!canWrite || saving}>保存</button>
                        <button className="btn btn-secondary btn-xs" type="button" onClick={() => void deleteSourceOption(option)} disabled={!canWrite || saving}>删除</button>
                      </div>
                    );
                  })}
                  {canWrite && (
                    <div className="form-source-option-row form-source-option-new">
                      <input value={sourceOptionDraft.key} placeholder="来源标识" onChange={(event) => setSourceOptionDraft((prev) => ({ ...prev, key: event.target.value }))} disabled={saving} />
                      <input value={sourceOptionDraft.label} placeholder="名称" onChange={(event) => setSourceOptionDraft((prev) => ({ ...prev, label: event.target.value }))} disabled={saving} />
                      <input value={sourceOptionDraft.sort_order} placeholder="排序" onChange={(event) => setSourceOptionDraft((prev) => ({ ...prev, sort_order: event.target.value }))} disabled={saving} />
                      <label><input type="checkbox" checked={sourceOptionDraft.is_active} onChange={(event) => setSourceOptionDraft((prev) => ({ ...prev, is_active: event.target.checked }))} disabled={saving} />启用</label>
                      <label><input type="checkbox" checked={sourceOptionDraft.allow_free_text} onChange={(event) => setSourceOptionDraft((prev) => ({ ...prev, allow_free_text: event.target.checked }))} disabled={saving} />补充</label>
                      <button className="btn btn-sm" type="button" onClick={() => void createSourceOption()} disabled={saving}>新增</button>
                    </div>
                  )}
                </div>
              </section>
            )}

            <section className="form-builder-section">
              <div className="platform-section-head">
                <div>
                  <h4>问题</h4>
                  <p>{selectedForm.questions?.length || 0} 个问题</p>
                </div>
              </div>
              <div className="form-builder-question-list">
                {(selectedForm.questions || []).map((question, index) => renderQuestionEdit(question, index))}
              </div>
              {canWrite && (
                <div className="form-builder-question add-question">
                  <div className="form-builder-question-head">
                    <span>+</span>
                    <input value={questionDraft.title} placeholder="问题标题" onChange={(event) => setQuestionDraft((prev) => ({ ...prev, title: event.target.value }))} disabled={saving} />
                    <select value={questionDraft.type} onChange={(event) => setQuestionDraft((prev) => ({ ...prev, type: event.target.value as PlatformAppFormQuestionType }))} disabled={saving}>
                      {QUESTION_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                    </select>
                  </div>
                  <div className="tenant-feedback-filter-row form-builder-question-grid">
                    <label>
                      <span>字段标识</span>
                      <input value={questionDraft.question_key} onChange={(event) => setQuestionDraft((prev) => ({ ...prev, question_key: event.target.value }))} disabled={saving} />
                    </label>
                    <label>
                      <span>说明</span>
                      <input value={questionDraft.description} onChange={(event) => setQuestionDraft((prev) => ({ ...prev, description: event.target.value }))} disabled={saving} />
                    </label>
                    <label className="checkbox-line">
                      <input type="checkbox" checked={questionDraft.required} onChange={(event) => setQuestionDraft((prev) => ({ ...prev, required: event.target.checked }))} disabled={saving} />
                      必填
                    </label>
                  </div>
                  {isOptionQuestion(questionDraft.type) && (
                    <label className="form-builder-option-lines">
                      <span>选项</span>
                      <textarea rows={4} value={questionDraft.option_lines} placeholder={'字段标识|显示文案\nother|其他'} onChange={(event) => setQuestionDraft((prev) => ({ ...prev, option_lines: event.target.value }))} disabled={saving} />
                    </label>
                  )}
                  <div className="form-builder-question-actions">
                    <button className="btn btn-sm" type="button" onClick={() => void addQuestion()} disabled={saving}>添加问题</button>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="tenant-forms-page">
      {message && <div className={`alert ${message.type}`}>{message.text}</div>}
      <div className="platform-section-head forms-page-head">
        <div>
          <h3>表单</h3>
          <p>{forms.length} 个表单</p>
        </div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadForms(null)} disabled={loading}>刷新</button>
      </div>

      {canWrite && (
        <div className="form-create-row">
          <input
            value={newForm.name}
            onChange={(event) => setNewForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="新表单名称"
            disabled={saving}
          />
          <input
            value={newForm.form_key}
            onChange={(event) => setNewForm((prev) => ({ ...prev, form_key: event.target.value }))}
            placeholder="表单标识"
            disabled={saving}
          />
          <button className="btn btn-sm" type="button" onClick={() => void createForm()} disabled={saving}>创建</button>
        </div>
      )}

      <div className="form-list-table-wrap">
        <table className="form-list-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>状态</th>
              <th>提交</th>
              <th>最近提交</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {forms.map((form) => (
              <tr key={form.id} onClick={() => openDetail(form.id)}>
                <td>
                  <strong>{form.name}</strong>
                  <span>{form.form_key}</span>
                </td>
                <td>{formTypeLabel(form.form_type)}</td>
                <td>{form.published_version ? `v${form.published_version}` : formStatusLabel(form.status)}</td>
                <td>{form.response_count || 0}</td>
                <td>{formatDateTime(form.last_response_at)}</td>
                <td><button className="btn btn-secondary btn-xs" type="button" onClick={(event) => { event.stopPropagation(); openDetail(form.id); }}>查看</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!forms.length && !loading ? <div className="loading">暂无表单</div> : null}
      </div>
    </div>
  );
}
