'use client';

import React, { FC, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
  useIntelligence,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  EmptyState,
  formatDate,
  humanize,
  inputClass,
  labelClass,
  LoadError,
  Loading,
  PageHeader,
  PageShell,
} from '@gitroom/frontend/components/agency/agency.ui';

interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  source?: string;
  sentimentScore: number;
  tags: string[];
  similarity: number;
}

interface SearchResponse {
  results: SearchResult[];
  method: string;
  semantic: boolean;
  documentsSearched: number;
}

const CATEGORIES = [
  'DISCUSSION',
  'CAMPAIGN_BRIEF',
  'FAQ',
  'SOP',
  'MARKET_RESEARCH',
];

const sentimentWord = (score: number) =>
  score > 0.15 ? 'Positive' : score < -0.15 ? 'Negative' : 'Neutral';

// ---------------------------------------------------------------------------
// Add a document
// ---------------------------------------------------------------------------
const AddDocumentDialog: FC<{ onClose: () => void; onSaved: () => void }> = ({
  onClose,
  onSaved,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [form, setForm] = useState({
    title: '',
    category: 'FAQ',
    source: '',
    tags: '',
    content: '',
    authorizationConfirmed: false,
  });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const errors: Record<string, string | null> = {
    title: form.title.trim() ? null : 'Give the document a title.',
    content: form.content.trim() ? null : 'Paste the text to store.',
    authorizationConfirmed: form.authorizationConfirmed
      ? null
      : 'Confirm you are allowed to store this content.',
  };
  const invalid = Object.values(errors).some(Boolean);
  const blur = (key: string) => () =>
    setTouched((t) => ({ ...t, [key]: true }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ title: true, content: true, authorizationConfirmed: true });
    if (invalid) return;
    setBusy(true);
    try {
      await api.post('/agency/intelligence/ingest', {
        title: form.title.trim(),
        category: form.category,
        source: form.source.trim() || undefined,
        content: form.content.trim(),
        tags: form.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        authorizationConfirmed: true,
      });
      toaster.show('Document stored', 'success');
      onSaved();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="doc-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-lg w-full shadow-2xl flex flex-col gap-4"
      >
        <h3 id="doc-title" className="text-base font-bold text-newTextColor">
          Add a document
        </h3>

        <div>
          <label htmlFor="doc-name" className={labelClass}>
            Title
          </label>
          <input
            id="doc-name"
            autoFocus
            maxLength={300}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            onBlur={blur('title')}
            aria-invalid={touched.title && !!errors.title}
            className={inputClass}
          />
          {touched.title && errors.title && (
            <p className="text-[11px] text-rose-400 mt-1">{errors.title}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="doc-category" className={labelClass}>
              Type
            </label>
            <select
              id="doc-category"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className={inputClass}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="doc-source" className={labelClass}>
              Source (optional)
            </label>
            <input
              id="doc-source"
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label htmlFor="doc-content" className={labelClass}>
            Text
          </label>
          <textarea
            id="doc-content"
            rows={6}
            maxLength={20000}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            onBlur={blur('content')}
            aria-invalid={touched.content && !!errors.content}
            className={clsx(inputClass, 'resize-y')}
          />
          {touched.content && errors.content && (
            <p className="text-[11px] text-rose-400 mt-1">{errors.content}</p>
          )}
        </div>

        <div>
          <label htmlFor="doc-tags" className={labelClass}>
            Tags (optional, comma separated)
          </label>
          <input
            id="doc-tags"
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            className={inputClass}
          />
        </div>

        <label className="flex items-start gap-2 text-xs text-newTextColor">
          <input
            type="checkbox"
            checked={form.authorizationConfirmed}
            onChange={(e) =>
              setForm({ ...form, authorizationConfirmed: e.target.checked })
            }
            onBlur={blur('authorizationConfirmed')}
            aria-invalid={
              touched.authorizationConfirmed && !!errors.authorizationConfirmed
            }
            className="mt-0.5"
          />
          <span>
            I am allowed to store this. If it comes from a group chat, the
            group’s administrator authorized it and its members were told.
          </span>
        </label>
        {touched.authorizationConfirmed && errors.authorizationConfirmed && (
          <p className="text-[11px] text-rose-400 -mt-2">
            {errors.authorizationConfirmed}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Store document
          </Btn>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const SearchPanel = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<SearchResponse | null>(null);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResponse(
        await api.post<SearchResponse>('/agency/intelligence/search', {
          query: query.trim(),
          category: category || undefined,
          limit: 10,
        })
      );
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Search"
      subtitle="Find stored documents related to a question or topic."
    >
      <form onSubmit={search} className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="kb-query">
          Search query
        </label>
        <input
          id="kb-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. refund policy for ad placements"
          className={clsx(inputClass, 'flex-1 min-w-48')}
        />
        <label className="sr-only" htmlFor="kb-category">
          Type
        </label>
        <select
          id="kb-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={clsx(inputClass, 'w-auto')}
        >
          <option value="">All types</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {humanize(c)}
            </option>
          ))}
        </select>
        <Btn
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!query.trim()}
        >
          Search
        </Btn>
      </form>

      {response && (
        <>
          <p className="text-[11px] text-textItemBlur">
            {response.semantic
              ? `Ranked by meaning using ${response.method}.`
              : 'Ranked by shared words only. No embedding model is available, so related wording without the same words will not match.'}{' '}
            {response.documentsSearched} document
            {response.documentsSearched === 1 ? '' : 's'} searched.
          </p>
          {response.results.length === 0 ? (
            <EmptyState title="No matches" hint="Try different words." />
          ) : (
            <ul className="flex flex-col gap-3">
              {response.results.map((r) => (
                <li
                  key={r.id}
                  className="rounded-lg border border-newBgLineColor bg-newBgColor p-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-xs font-semibold text-newTextColor">
                      {r.title}
                    </h3>
                    <span className="text-[11px] text-textItemBlur whitespace-nowrap">
                      {Math.round(r.similarity * 100)}% match
                    </span>
                  </div>
                  <p className="text-[11px] text-textItemBlur mt-0.5">
                    {humanize(r.category)}
                    {r.source && ` · ${r.source}`}
                  </p>
                  <p className="text-xs text-newTextColor mt-2 line-clamp-3 whitespace-pre-wrap break-words">
                    {r.content}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------
const RetentionPanel: FC<{ onChanged: () => void }> = ({ onChanged }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [category, setCategory] = useState('');
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);

  const reindex = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ updated: number; remaining: number }>(
        '/agency/intelligence/reindex'
      );
      toaster.show(
        `${r.updated} document${r.updated === 1 ? '' : 's'} indexed${
          r.remaining ? `, ${r.remaining} remaining` : ''
        }`,
        'success'
      );
      onChanged();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const purge = async () => {
    const n = Number(days);
    if (!category && !(n > 0)) return;
    const scope = [
      category
        ? `every ${humanize(category).toLowerCase()} document`
        : 'every document',
      n > 0 ? `older than ${n} days` : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (
      !(await deleteDialog(
        `Permanently delete ${scope}? This can’t be undone.`
      ))
    )
      return;
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (category) params.set('category', category);
      if (n > 0) params.set('olderThanDays', String(Math.floor(n)));
      const r = await api.del<{ deleted: number }>(
        `/agency/intelligence?${params.toString()}`
      );
      toaster.show(
        `${r.deleted} document${r.deleted === 1 ? '' : 's'} deleted`,
        'success'
      );
      onChanged();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-5">
      <summary className="text-sm font-bold text-newTextColor cursor-pointer">
        Data retention and indexing
      </summary>
      <div className="mt-4 flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-textItemBlur max-w-md">
            Documents stored while no embedding model was reachable only support
            keyword search. Re-index them once a model is available.
          </p>
          <Btn onClick={reindex} busy={busy}>
            Re-index
          </Btn>
        </div>
        <div>
          <p className="text-xs text-textItemBlur mb-2">
            Delete stored documents by type, by age, or both.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="purge-category" className={labelClass}>
                Type
              </label>
              <select
                id="purge-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={clsx(inputClass, 'w-auto')}
              >
                <option value="">Any</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="purge-days" className={labelClass}>
                Older than (days)
              </label>
              <input
                id="purge-days"
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className={clsx(inputClass, 'w-28')}
              />
            </div>
            <Btn
              variant="danger"
              onClick={purge}
              busy={busy}
              disabled={!category && !(Number(days) > 0)}
            >
              Delete…
            </Btn>
          </div>
        </div>
      </div>
    </details>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export const AgencyIntelligenceComponent = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const { data, error, mutate } = useIntelligence();
  const [adding, setAdding] = useState(false);
  const canManage = can('intelligence:manage');

  const remove = async (id: string, title: string) => {
    if (!(await deleteDialog(`Delete “${title}”? This can’t be undone.`)))
      return;
    try {
      await api.del(`/agency/intelligence/${id}`);
      toaster.show('Document deleted', 'success');
      await mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  return (
    <PageShell>
      <PageHeader
        crumb="Knowledge base"
        title="Knowledge base"
        subtitle="Briefs, FAQs and approved research your team stores to reuse. Only content you are authorized to keep belongs here."
        actions={
          canManage ? (
            <Btn variant="primary" onClick={() => setAdding(true)}>
              Add document
            </Btn>
          ) : undefined
        }
      />

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4">
              <p className="text-xs text-textItemBlur">Documents</p>
              <p className="mt-2 text-2xl font-bold text-newTextColor">
                {data.totalDocuments}
              </p>
            </div>
            <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4">
              <p className="text-xs text-textItemBlur">Overall tone</p>
              <p className="mt-2 text-2xl font-bold text-newTextColor">
                {data.totalDocuments ? data.sentimentLabel : '—'}
              </p>
              <p className="text-[11px] text-textItemBlur mt-1">
                Simple word-list score, not a trained model
              </p>
            </div>
            <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 col-span-2 lg:col-span-1">
              <p className="text-xs text-textItemBlur">By type</p>
              <p className="mt-2 text-xs text-newTextColor">
                {Object.keys(data.categoryBreakdown).length
                  ? Object.entries(data.categoryBreakdown)
                      .map(([k, v]) => `${humanize(k)} ${v}`)
                      .join(' · ')
                  : '—'}
              </p>
            </div>
          </div>

          {data.totalDocuments === 0 ? (
            <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
              <EmptyState
                title="Nothing stored yet"
                hint="Add a brief, FAQ or research note and it becomes searchable here."
                action={
                  canManage ? (
                    <Btn variant="primary" onClick={() => setAdding(true)}>
                      Add document
                    </Btn>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <SearchPanel />

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="Recently added">
                  <ul className="flex flex-col divide-y divide-newBgLineColor">
                    {data.recentInsights.map((d: any) => (
                      <li
                        key={d.id}
                        className="py-2.5 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-newTextColor truncate">
                            {d.title}
                          </p>
                          <p className="text-[11px] text-textItemBlur">
                            {humanize(d.category)} ·{' '}
                            {sentimentWord(d.sentimentScore)} ·{' '}
                            {formatDate(d.createdAt)}
                          </p>
                        </div>
                        {canManage && (
                          <button
                            onClick={() => void remove(d.id, d.title)}
                            className="text-[11px] text-rose-400 hover:underline"
                          >
                            Delete
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>

                <Card
                  title="Frequent tags"
                  subtitle="Counted from the tags on stored documents."
                >
                  {data.trendingTopics.length === 0 ? (
                    <EmptyState title="No tags yet" />
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {data.trendingTopics.map((t: any) => (
                        <li
                          key={t.topic}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-newTextColor">{t.topic}</span>
                          <span className="text-textItemBlur">
                            {t.count} · {humanize(t.sentiment)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              {canManage && <RetentionPanel onChanged={() => mutate()} />}
            </>
          )}
        </>
      )}

      {adding && (
        <AddDocumentDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void mutate();
          }}
        />
      )}
    </PageShell>
  );
};
