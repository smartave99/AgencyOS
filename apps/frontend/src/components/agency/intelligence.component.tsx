'use client';

import React, { FC, useState } from 'react';
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
  CheckField,
  Dialog,
  EmptyState,
  formatDate,
  humanize,
  Icon,
  inputClass,
  LoadError,
  Loading,
  Notice,
  PageHeader,
  PageShell,
  SelectField,
  Stat,
  TextArea,
  TextField,
  useBusy,
  useTouched,
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

const CATEGORY_LABEL: Record<string, string> = {
  DISCUSSION: 'Discussion',
  CAMPAIGN_BRIEF: 'Campaign brief',
  FAQ: 'FAQ',
  SOP: 'SOP',
  MARKET_RESEARCH: 'Market research',
};
const categoryLabel = (key: string) => CATEGORY_LABEL[key] ?? humanize(key);

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
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [form, setForm] = useState({
    title: '',
    category: 'FAQ',
    source: '',
    tags: '',
    content: '',
    authorizationConfirmed: false,
  });

  const errors: Record<string, string | null> = {
    title: form.title.trim() ? null : 'Give the document a title.',
    content: form.content.trim() ? null : 'Paste the text to store.',
    authorizationConfirmed: form.authorizationConfirmed
      ? null
      : 'Confirm you are allowed to store this content.',
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(Object.keys(errors));
    if (Object.values(errors).some(Boolean)) return;
    await run(async () => {
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
      }
    });
  };

  return (
    <Dialog
      size="lg"
      title="Add a document"
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Store document
          </Btn>
        </>
      }
    >
      <TextField
        autoFocus
        label="Title"
        maxLength={300}
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        onBlur={touched.blur('title')}
        error={touched.show('title', errors.title)}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SelectField
          label="Type"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Source"
          optional
          value={form.source}
          onChange={(e) => setForm({ ...form, source: e.target.value })}
        />
      </div>
      <TextArea
        label="Text"
        rows={6}
        maxLength={20000}
        className="resize-y"
        value={form.content}
        onChange={(e) => setForm({ ...form, content: e.target.value })}
        onBlur={touched.blur('content')}
        error={touched.show('content', errors.content)}
      />
      <TextField
        label="Tags"
        optional
        hint="Comma separated."
        value={form.tags}
        onChange={(e) => setForm({ ...form, tags: e.target.value })}
      />
      <CheckField
        checked={form.authorizationConfirmed}
        onChange={(e) =>
          setForm({ ...form, authorizationConfirmed: e.target.checked })
        }
        onBlur={touched.blur('authorizationConfirmed')}
        error={touched.show(
          'authorizationConfirmed',
          errors.authorizationConfirmed
        )}
      >
        I am allowed to store this. If it comes from a group chat, the group’s
        administrator authorized it and its members were told.
      </CheckField>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const SearchPanel = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    await run(async () => {
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
      }
    });
  };

  return (
    <Card
      title="Search"
      subtitle="Find stored documents related to a question or topic."
    >
      <form onSubmit={search} className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-48">
          <Icon
            name="search"
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-textItemBlur"
          />
          <label className="sr-only" htmlFor="kb-query">
            Search query
          </label>
          <input
            id="kb-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. refund policy for ad placements"
            className={`${inputClass} pl-8`}
          />
        </div>
        <div className="w-44">
          <label className="sr-only" htmlFor="kb-category">
            Type
          </label>
          <select
            id="kb-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={inputClass}
          >
            <option value="">All types</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <Btn
          type="submit"
          variant="primary"
          size="md"
          busy={busy}
          disabled={!query.trim()}
        >
          Search
        </Btn>
      </form>

      {response && (
        <>
          <p className="text-xs text-textItemBlur">
            {response.semantic
              ? `Ranked by meaning using ${response.method}.`
              : 'Ranked by shared words only. No embedding model is available, so related wording without the same words will not match.'}{' '}
            {response.documentsSearched} document
            {response.documentsSearched === 1 ? '' : 's'} searched.
          </p>
          {response.results.length === 0 ? (
            <EmptyState
              icon="search"
              title="No matches"
              hint="Try different words."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {response.results.map((r) => (
                <li
                  key={r.id}
                  className="rounded-xl bg-[var(--ag-neutral-bg)] p-4"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-[13px] font-semibold text-newTextColor">
                      {r.title}
                    </h3>
                    <span className="text-xs text-textItemBlur whitespace-nowrap tabular-nums">
                      {Math.round(r.similarity * 100)}% match
                    </span>
                  </div>
                  <p className="text-xs text-textItemBlur mt-0.5">
                    {categoryLabel(r.category)}
                    {r.source && ` · ${r.source}`}
                  </p>
                  <p className="text-[13px] leading-relaxed text-newTextColor mt-2 line-clamp-3 whitespace-pre-wrap break-words">
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
  const { busy, run } = useBusy();
  const [category, setCategory] = useState('');
  const [days, setDays] = useState('');

  const reindex = () =>
    run(async () => {
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
      }
    });

  const purge = async () => {
    const n = Number(days);
    if (!category && !(n > 0)) return;
    const scope = [
      category
        ? `every ${categoryLabel(category).toLowerCase()} document`
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
    await run(async () => {
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
      }
    });
  };

  return (
    <details className="group rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 sm:p-6">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[15px] font-semibold tracking-tight text-newTextColor">
        Data retention and indexing
        <Icon
          name="chevron"
          size={16}
          className="text-textItemBlur transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-5 flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-textItemBlur max-w-md">
            Documents stored while no embedding model was reachable only support
            keyword search. Re-index them once a model is available.
          </p>
          <Btn onClick={reindex} busy={busy}>
            Re-index
          </Btn>
        </div>
        <div>
          <p className="text-[13px] text-textItemBlur mb-3">
            Delete stored documents by type, by age, or both.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label="Type"
              wrapperClassName="w-44"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Any</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Older than (days)"
              wrapperClassName="w-40"
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
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
        title="Knowledge base"
        subtitle="Briefs, FAQs and approved research your team stores to reuse. Only content you are authorized to keep belongs here."
        actions={
          canManage ? (
            <Btn variant="primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={15} />
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Stat label="Documents" value={data.totalDocuments} />
            <Stat
              label="Overall tone"
              value={data.totalDocuments ? data.sentimentLabel : '—'}
              hint="Simple word-list score, not a trained model"
            />
            <Stat
              label="By type"
              value={Object.keys(data.categoryBreakdown).length}
              hint={
                Object.keys(data.categoryBreakdown).length
                  ? Object.entries(data.categoryBreakdown)
                      .map(([k, v]) => `${categoryLabel(k)} ${v}`)
                      .join(' · ')
                  : 'Nothing stored yet'
              }
            />
          </div>

          {data.totalDocuments === 0 ? (
            <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
              <EmptyState
                icon="book"
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
                  <ul className="flex flex-col">
                    {data.recentInsights.map((d: any) => (
                      <li
                        key={d.id}
                        className="py-3 flex items-center justify-between gap-3 border-t first:border-t-0 border-[color:var(--ag-hairline)]"
                      >
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-newTextColor truncate">
                            {d.title}
                          </p>
                          <p className="text-xs text-textItemBlur">
                            {categoryLabel(d.category)} ·{' '}
                            {sentimentWord(d.sentimentScore)} ·{' '}
                            {formatDate(d.createdAt)}
                          </p>
                        </div>
                        {canManage && (
                          <Btn
                            variant="ghost"
                            onClick={() => void remove(d.id, d.title)}
                          >
                            Delete
                          </Btn>
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
                    <EmptyState icon="doc" title="No tags yet" />
                  ) : (
                    <ul className="flex flex-col">
                      {data.trendingTopics.map((t: any) => (
                        <li
                          key={t.topic}
                          className="flex items-center justify-between py-2 text-[13px] border-t first:border-t-0 border-[color:var(--ag-hairline)]"
                        >
                          <span className="text-newTextColor">{t.topic}</span>
                          <span className="text-textItemBlur tabular-nums">
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
