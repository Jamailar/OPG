import { CSSProperties, FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { runtimeContext } from '@/lib/runtime-context';

type FormBlock = {
  id?: string;
  key: string;
  type: string;
  title: string;
  description?: string;
  required?: boolean;
  options?: Array<{ key: string; label: string; allow_free_text?: boolean }>;
  validation?: Record<string, unknown>;
  properties?: Record<string, unknown>;
};

type FormManifest = {
  app?: { id?: string; slug?: string; name?: string };
  form?: {
    key?: string;
    name?: string;
    title?: string;
    subtitle?: string;
    submit_label?: string;
    success_title?: string;
    success_message?: string;
    theme?: Record<string, unknown>;
  };
  blocks?: FormBlock[];
};

function apiBase() {
  return runtimeContext.apiBaseUrl.replace(/\/+$/, '');
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function authHeaders(appSlug: string): Record<string, string> {
  const token = typeof window === 'undefined' ? '' : localStorage.getItem('access_token') || '';
  if (!token) return {};
  const payload = decodeJwtPayload(token);
  const tokenAppSlug = String(payload?.appSlug || payload?.app_slug || '').trim().toLowerCase();
  if (!tokenAppSlug || tokenAppSlug !== appSlug.trim().toLowerCase()) return {};
  return { Authorization: `Bearer ${token}` };
}

function submitErrorMessage(message: string) {
  const normalized = message.trim().toLowerCase();
  if (normalized.includes('login required') || normalized.includes('token app mismatch') || normalized.includes('invalid access token')) {
    return '请先在当前 App 登录后提交';
  }
  return message || '提交失败';
}

function isChoiceType(type: string) {
  return ['single_select', 'source_select'].includes(type);
}

function isMultiChoiceType(type: string) {
  return type === 'multi_select';
}

function themeValue(theme: Record<string, unknown> | undefined, key: string, fallback: string) {
  const value = String(theme?.[key] || '').trim();
  return value || fallback;
}

export default function HostedFormShell() {
  const { appSlug = '', formKey = '' } = useParams();
  const [manifest, setManifest] = useState<FormManifest | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const blocks = useMemo(() => (manifest?.blocks || []).filter((block) => block.type !== 'hidden'), [manifest?.blocks]);
  const hidden = useMemo(() => Object.fromEntries((manifest?.blocks || []).filter((block) => block.type === 'hidden').map((block) => [block.key, answers[block.key] || ''])), [answers, manifest?.blocks]);
  const theme = manifest?.form?.theme || {};
  const primaryColor = themeValue(theme, 'primary_color', '#2563eb');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`${apiBase()}/${encodeURIComponent(appSlug)}/v1/forms/${encodeURIComponent(formKey)}/manifest`, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('form not found');
        const data = await response.json();
        if (alive) setManifest(data);
      } catch {
        if (alive) setError('表单不可用');
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [appSlug, formKey]);

  useEffect(() => {
    const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    window.parent?.postMessage({ type: 'opg_form_resize', form_key: formKey, height }, '*');
  }, [answers, formKey, loading, submitted, error]);

  const setAnswer = (key: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  };

  const toggleMultiAnswer = (key: string, value: string, checked: boolean) => {
    setAnswers((prev) => {
      const current = Array.isArray(prev[key]) ? [...(prev[key] as string[])] : [];
      const next = checked ? Array.from(new Set([...current, value])) : current.filter((item) => item !== value);
      return { ...prev, [key]: next };
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!manifest?.form?.key) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/${encodeURIComponent(appSlug)}/v1/forms/${encodeURIComponent(formKey)}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(appSlug),
        },
        body: JSON.stringify({
          answers,
          hidden,
          metadata: {
            embedded_path: window.location.pathname,
          },
          idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data?.message || 'submit failed'));
      setSubmitted(true);
      window.parent?.postMessage({ type: 'opg_form_submitted', form_key: formKey }, '*');
    } catch (submitError: any) {
      setError(submitErrorMessage(String(submitError?.message || '')));
    } finally {
      setSubmitting(false);
    }
  };

  const renderBlock = (block: FormBlock) => {
    const value = answers[block.key];
    if (block.type === 'statement') {
      return (
        <div className="hosted-form-statement" key={block.key}>
          <strong>{block.title}</strong>
          {block.description ? <p>{block.description}</p> : null}
        </div>
      );
    }
    if (block.type === 'long_text') {
      return (
        <label className="hosted-form-field" key={block.key}>
          <span>{block.title}{block.required ? ' *' : ''}</span>
          {block.description ? <small>{block.description}</small> : null}
          <textarea value={String(value || '')} rows={4} onChange={(event) => setAnswer(block.key, event.target.value)} required={block.required} />
        </label>
      );
    }
    if (['number', 'rating', 'opinion_scale'].includes(block.type)) {
      return (
        <label className="hosted-form-field" key={block.key}>
          <span>{block.title}{block.required ? ' *' : ''}</span>
          {block.description ? <small>{block.description}</small> : null}
          <input type="number" value={String(value ?? '')} onChange={(event) => setAnswer(block.key, event.target.value)} required={block.required} />
        </label>
      );
    }
    if (block.type === 'nps') {
      return (
        <fieldset className="hosted-form-field hosted-form-nps" key={block.key}>
          <legend>{block.title}{block.required ? ' *' : ''}</legend>
          {block.description ? <small>{block.description}</small> : null}
          <div>
            {Array.from({ length: 11 }, (_, score) => (
              <button
                key={score}
                type="button"
                className={Number(value) === score ? 'active' : ''}
                onClick={() => setAnswer(block.key, score)}
              >
                {score}
              </button>
            ))}
          </div>
        </fieldset>
      );
    }
    if (isChoiceType(block.type)) {
      return (
        <fieldset className="hosted-form-field hosted-form-choice" key={block.key}>
          <legend>{block.title}{block.required ? ' *' : ''}</legend>
          {block.description ? <small>{block.description}</small> : null}
          {(block.options || []).map((option) => (
            <label key={option.key}>
              <input
                type="radio"
                name={block.key}
                checked={value === option.key}
                onChange={() => setAnswer(block.key, option.key)}
                required={block.required}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      );
    }
    if (isMultiChoiceType(block.type)) {
      const current = Array.isArray(value) ? value as string[] : [];
      return (
        <fieldset className="hosted-form-field hosted-form-choice" key={block.key}>
          <legend>{block.title}{block.required ? ' *' : ''}</legend>
          {block.description ? <small>{block.description}</small> : null}
          {(block.options || []).map((option) => (
            <label key={option.key}>
              <input
                type="checkbox"
                checked={current.includes(option.key)}
                onChange={(event) => toggleMultiAnswer(block.key, option.key, event.target.checked)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      );
    }
    if (['boolean', 'consent'].includes(block.type)) {
      return (
        <label className="hosted-form-field hosted-form-check" key={block.key}>
          <input type="checkbox" checked={Boolean(value)} onChange={(event) => setAnswer(block.key, event.target.checked)} required={block.required} />
          <span>{block.title}{block.required ? ' *' : ''}</span>
        </label>
      );
    }
    return (
      <label className="hosted-form-field" key={block.key}>
        <span>{block.title}{block.required ? ' *' : ''}</span>
        {block.description ? <small>{block.description}</small> : null}
        <input
          type={block.type === 'email' ? 'email' : block.type === 'url' ? 'url' : block.type === 'date' ? 'date' : 'text'}
          value={String(value || '')}
          onChange={(event) => setAnswer(block.key, event.target.value)}
          required={block.required}
        />
      </label>
    );
  };

  return (
    <main
      className="hosted-form-page"
      style={{
        '--hosted-form-primary': primaryColor,
        '--hosted-form-bg': themeValue(theme, 'background_color', '#ffffff'),
        '--hosted-form-text': themeValue(theme, 'text_color', '#111827'),
      } as CSSProperties}
    >
      <section className="hosted-form-shell">
        {loading ? <div className="loading">加载中...</div> : null}
        {!loading && error ? <div className="alert error">{error}</div> : null}
        {!loading && manifest && !submitted ? (
          <form className="hosted-form" onSubmit={submit}>
            <header>
              <h1>{manifest.form?.title || manifest.form?.name || '表单'}</h1>
              {manifest.form?.subtitle ? <p>{manifest.form.subtitle}</p> : null}
            </header>
            <div className="hosted-form-fields">
              {blocks.map((block) => renderBlock(block))}
            </div>
            {error ? <div className="alert error">{error}</div> : null}
            <button className="hosted-form-submit" type="submit" disabled={submitting}>
              {submitting ? '提交中...' : manifest.form?.submit_label || '提交'}
            </button>
          </form>
        ) : null}
        {!loading && manifest && submitted ? (
          <div className="hosted-form-success">
            <h1>{manifest.form?.success_title || '提交成功'}</h1>
            {manifest.form?.success_message ? <p>{manifest.form.success_message}</p> : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
