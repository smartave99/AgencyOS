'use client';

import React, { FC, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  useAgencyApi,
  useCan,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  CommunityFilterState,
  CommunityView,
  useCommunities,
  useCommunityDuplicates,
  useTelegramUserAccounts,
} from '@gitroom/frontend/components/agency/telegram.users.hooks';
import {
  Btn,
  Card,
  EmptyState,
  humanize,
  LoadError,
  Loading,
  Menu,
  Notice,
  PageHeader,
  PageShell,
  Segmented,
  SelectField,
  StatusBadge,
  tableClass,
  TextArea,
  TextField,
  timeAgo,
  useBusy,
} from '@gitroom/frontend/components/agency/agency.ui';

interface FoundCommunity {
  title: string;
  username: string | null;
  memberCount: number | null;
  description: string | null;
  kind: string | null;
  saved: { id: string; stage: string } | null;
}

const STAGES = [
  'DISCOVERED',
  'REVIEW_REQUIRED',
  'JOIN_REQUEST_PENDING',
  'JOINED',
  'ADVERTISING_ALLOWED',
  'PUBLISHING_AUTHORIZED',
  'NOT_ELIGIBLE',
  'BLOCKED',
];

export const stageLabel = (stage: string) =>
  stage === 'BLOCKED' ? 'Blocked' : humanize(stage);

/** A number Telegram did not give is shown as such, never as zero. */
export const members = (n: number | null) =>
  n === null ? 'Not shown' : n.toLocaleString();

// ---------------------------------------------------------------------------
// Find: Telegram's own public search, and a pasted list
// ---------------------------------------------------------------------------
const Find: FC<{
  accountId: string;
  canRun: boolean;
  onSaved: () => void;
}> = ({ accountId, canRun, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const search = useBusy();
  const importing = useBusy();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FoundCommunity[] | null>(null);
  const [list, setList] = useState('');
  const [tags, setTags] = useState('');
  const [category, setCategory] = useState('');
  const [language, setLanguage] = useState('');
  const [checked, setChecked] = useState<Array<{
    input: string;
    ok: boolean;
    reason: string | null;
  }> | null>(null);

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (query.trim().length < 2) return;
    await search.run(async () => {
      try {
        const res = await api.post<{ results: FoundCommunity[] }>(
          '/agency/communities/search',
          { accountId, query: query.trim(), limit: 30 }
        );
        setFound(res.results);
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const save = async (refs: string[], source: string) => {
    return api.post<{
      created: number;
      updated: number;
      failed: Array<{ input: string; code: string; message: string }>;
      retryAfterSeconds: number | null;
    }>('/agency/communities/import', {
      accountId,
      refs,
      source,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      category: category.trim() || undefined,
      language: language.trim() || undefined,
    });
  };

  const saveFound = async (c: FoundCommunity) => {
    if (!c.username) return;
    try {
      const out = await save([`@${c.username}`], 'search');
      toaster.show(
        out.created ? 'Saved to your directory.' : 'Already saved; refreshed.',
        'success'
      );
      onSaved();
      await runSearch();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const refs = useMemo(
    () =>
      list
        .split(/[\n,;]+/)
        .map((r) => r.trim())
        .filter(Boolean),
    [list]
  );

  const check = async () => {
    if (!refs.length) return;
    try {
      setChecked(
        await api.post('/agency/communities/validate', {
          refs: refs.slice(0, 200),
        })
      );
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const runImport = async () => {
    await importing.run(async () => {
      try {
        const out = await save(refs, 'import');
        const failed = out.failed.length;
        toaster.show(
          `${out.created} added, ${out.updated} refreshed${
            failed ? `, ${failed} not saved` : ''
          }.${
            out.retryAfterSeconds
              ? ' Telegram asked to wait; try the rest in a minute.'
              : ''
          }`,
          failed || out.retryAfterSeconds ? 'warning' : 'success'
        );
        setChecked(
          out.failed.length
            ? out.failed.map((f) => ({
                input: f.input,
                ok: false,
                reason: f.message,
              }))
            : null
        );
        if (!out.failed.length) setList('');
        onSaved();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const tooMany = refs.length > 50;

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Search Telegram"
        subtitle="Telegram's own public search: names and public information only. Nothing is saved until you press Save."
      >
        <form className="flex flex-wrap items-end gap-3" onSubmit={runSearch}>
          <TextField
            label="Search"
            wrapperClassName="grow min-w-[14rem]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="sourdough bakers"
          />
          <Btn
            variant="primary"
            type="submit"
            busy={search.busy}
            disabled={!canRun || query.trim().length < 2}
          >
            Search
          </Btn>
        </form>
        {found && found.length === 0 && (
          <p className="text-[13px] text-textItemBlur">
            Telegram found no public community for that.
          </p>
        )}
        {found && found.length > 0 && (
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>Community</th>
                  <th className={`${tableClass.th} text-right`}>Members</th>
                  <th className={tableClass.th} />
                </tr>
              </thead>
              <tbody>
                {found.map((c) => (
                  <tr
                    key={`${c.username}-${c.title}`}
                    className={`${tableClass.row} align-top`}
                  >
                    <td className={tableClass.td}>
                      <div className="font-medium text-newTextColor">
                        {c.title}
                      </div>
                      <div className="text-xs text-textItemBlur">
                        {c.username ? `@${c.username}` : 'No public name'}
                        {c.description
                          ? ` · ${c.description.slice(0, 90)}`
                          : ''}
                      </div>
                    </td>
                    <td
                      className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                    >
                      {members(c.memberCount)}
                    </td>
                    <td className={`${tableClass.td} text-right`}>
                      {c.saved ? (
                        <Link
                          href={`/agency/communities/${c.saved.id}`}
                          className="text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
                        >
                          Saved · open
                        </Link>
                      ) : (
                        <Btn
                          disabled={!c.username || !canRun}
                          onClick={() => saveFound(c)}
                        >
                          Save
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Import a list"
        subtitle="Public names (@name) or t.me links, one per line, up to 50. Each one is looked up on Telegram and saved as Telegram shows it."
      >
        <TextArea
          label="Names or links"
          rows={5}
          value={list}
          onChange={(e) => {
            setList(e.target.value);
            setChecked(null);
          }}
          error={tooMany ? 'At most 50 at a time.' : undefined}
          placeholder={'@bakers_united\nhttps://t.me/sourdough_club'}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TextField
            label="Tags"
            optional
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            hint="Separated by commas"
          />
          <TextField
            label="Category"
            optional
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <TextField
            label="Language"
            optional
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en"
          />
        </div>
        {checked && (
          <ul className="flex flex-col gap-1 text-[13px]">
            {checked.map((c, i) => (
              <li
                key={`${c.input}-${i}`}
                className={c.ok ? 'text-newTextColor' : 'text-textItemBlur'}
              >
                {c.ok ? 'Will look up ' : 'Cannot use '}
                <span className="font-mono text-xs">{c.input}</span>
                {c.reason ? ` · ${c.reason}` : ''}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Btn onClick={check} disabled={!refs.length}>
            Check the list
          </Btn>
          <Btn
            variant="primary"
            busy={importing.busy}
            disabled={!canRun || !refs.length || tooMany}
            onClick={runImport}
          >
            Import {refs.length ? `${Math.min(refs.length, 50)}` : ''}
          </Btn>
        </div>
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------
const Directory: FC<{ accountId: string; canRun: boolean }> = ({
  accountId,
  canRun,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const refreshing = useBusy();
  const [filters, setFilters] = useState<CommunityFilterState>({
    search: '',
    stage: '',
    bookmarked: false,
    sort: 'title',
    category: '',
  });
  const [picked, setPicked] = useState<string[]>([]);
  const list = useCommunities(filters);
  const repeats = useCommunityDuplicates();
  const set = (patch: Partial<CommunityFilterState>) =>
    setFilters((f) => ({ ...f, ...patch }));

  const toggleBookmark = async (c: CommunityView) => {
    try {
      await api.put(`/agency/communities/${c.id}`, {
        bookmarked: !c.bookmarked,
      });
      void list.mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const refreshPicked = async () => {
    await refreshing.run(async () => {
      try {
        const out = await api.post<{
          refreshed: number;
          changed: number;
          problems: Array<{ title: string; code: string }>;
          retryAfterSeconds: number | null;
        }>('/agency/communities/refresh', {
          accountId,
          ids: picked.slice(0, 20),
        });
        toaster.show(
          `${out.refreshed} refreshed, ${out.changed} changed${
            out.problems.length
              ? `, ${out.problems.length} not shown by Telegram any more`
              : ''
          }.${
            out.retryAfterSeconds
              ? ' Telegram asked to wait; try again in a minute.'
              : ''
          }`,
          out.problems.length || out.retryAfterSeconds ? 'warning' : 'success'
        );
        setPicked([]);
        void list.mutate();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const download = async (format: 'csv' | 'json') => {
    const params = new URLSearchParams({ format });
    if (filters.stage) params.set('stage', filters.stage);
    if (filters.bookmarked) params.set('bookmarked', 'true');
    if (filters.search.trim()) params.set('search', filters.search.trim());
    try {
      await api.download(
        `/agency/communities/export?${params}`,
        `communities.${format}`
      );
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const rows = list.data ?? [];
  return (
    <Card
      title="Your directory"
      subtitle="Public information Telegram shows about each community. Never members, phone numbers or messages."
      right={
        <Menu
          label="Export"
          items={[
            { label: 'Download CSV', onClick: () => void download('csv') },
            { label: 'Download JSON', onClick: () => void download('json') },
          ]}
        />
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <TextField
          label="Search"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Name, @name or words"
        />
        <SelectField
          label="Where it is"
          value={filters.stage}
          onChange={(e) => set({ stage: e.target.value })}
        >
          <option value="">Everything</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {stageLabel(s)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Sort"
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value })}
        >
          <option value="title">Name</option>
          <option value="members">Members</option>
          <option value="recent">Newest first</option>
          <option value="refreshed">Longest since looked at</option>
        </SelectField>
        <div className="flex items-end">
          <Btn
            variant={filters.bookmarked ? 'primary' : 'secondary'}
            onClick={() => set({ bookmarked: !filters.bookmarked })}
          >
            {filters.bookmarked ? '★ Bookmarked only' : '☆ Bookmarked'}
          </Btn>
        </div>
      </div>

      {repeats.data && repeats.data.length > 0 && (
        <Notice tone="warn">
          {repeats.data.length} possible repeat
          {repeats.data.length === 1 ? '' : 's'}:{' '}
          {repeats.data
            .slice(0, 3)
            .map((g) => g.map((c) => c.title).join(' / '))
            .join('; ')}
          . Open them and remove the one you do not need.
        </Notice>
      )}

      {picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--ag-neutral-bg)] px-4 py-3 text-[13px]">
          <span>{picked.length} chosen</span>
          <Btn
            busy={refreshing.busy}
            disabled={!canRun || picked.length > 20}
            onClick={refreshPicked}
          >
            Refresh from Telegram
          </Btn>
          {picked.length > 20 && (
            <span className="text-textItemBlur">
              Refresh at most 20 at a time.
            </span>
          )}
          <Btn variant="ghost" onClick={() => setPicked([])}>
            Clear
          </Btn>
        </div>
      )}

      {!list.data ? (
        list.error ? (
          <LoadError error={list.error} onRetry={() => list.mutate()} />
        ) : (
          <Loading rows={4} />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="globe"
          title="Nothing saved yet"
          hint="Search Telegram, or import a list of public names, and save the communities worth a closer look."
        />
      ) : (
        <div className={tableClass.wrap}>
          <table className={tableClass.table}>
            <thead className={tableClass.head}>
              <tr>
                <th className={tableClass.th} />
                <th className={tableClass.th}>Community</th>
                <th className={`${tableClass.th} text-right`}>Members</th>
                <th className={tableClass.th}>Where it is</th>
                <th className={tableClass.th}>Looked at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={`${tableClass.row} align-top`}>
                  <td className={tableClass.td}>
                    <input
                      type="checkbox"
                      aria-label={`Choose ${c.title}`}
                      className="h-4 w-4 accent-[color:var(--ag-accent)]"
                      checked={picked.includes(c.id)}
                      onChange={(e) =>
                        setPicked((p) =>
                          e.target.checked
                            ? [...p, c.id]
                            : p.filter((x) => x !== c.id)
                        )
                      }
                    />
                  </td>
                  <td className={tableClass.td}>
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        aria-label={
                          c.bookmarked
                            ? `Remove bookmark from ${c.title}`
                            : `Bookmark ${c.title}`
                        }
                        className="text-textItemBlur hover:text-newTextColor"
                        onClick={() => toggleBookmark(c)}
                      >
                        {c.bookmarked ? '★' : '☆'}
                      </button>
                      <div className="min-w-0">
                        <Link
                          href={`/agency/communities/${c.id}`}
                          className="font-medium text-newTextColor hover:underline"
                        >
                          {c.title}
                        </Link>
                        <div className="text-xs text-textItemBlur">
                          {c.username ? `@${c.username}` : 'No public name'}
                          {c.category ? ` · ${c.category}` : ''}
                          {c.tags.length ? ` · ${c.tags.join(', ')}` : ''}
                          {!c.available ? ' · Telegram no longer shows it' : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td
                    className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                  >
                    {members(c.memberCount)}
                  </td>
                  <td className={tableClass.td}>
                    <StatusBadge status={c.stage} label={stageLabel(c.stage)} />
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {c.lastRefreshedAt ? timeAgo(c.lastRefreshedAt) : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
export const CommunitiesComponent: FC = () => {
  const { can } = useCan();
  const accounts = useTelegramUserAccounts();
  const [tab, setTab] = useState<'directory' | 'find'>('directory');
  const [accountId, setAccountId] = useState('');
  const [bump, setBump] = useState(0);

  const usable = (accounts.data ?? []).filter(
    (a) => a.permissions.canResearch && a.status === 'ACTIVE'
  );
  useEffect(() => {
    if (!accountId && usable.length) setAccountId(usable[0].id);
  }, [accountId, usable]);

  const canRun = can('research:run') && !!accountId;

  return (
    <PageShell>
      <PageHeader
        title="Communities"
        subtitle="Public Telegram communities: find them, keep a directory, join the ones that fit, and post only where advertising is allowed."
        actions={
          <Segmented
            ariaLabel="Communities view"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'directory', label: 'Directory' },
              { value: 'find', label: 'Find' },
            ]}
          />
        }
      />

      {accounts.data && usable.length === 0 && (
        <Notice
          tone="warn"
          action={
            <Link
              href="/agency/telegram/accounts"
              className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
            >
              Telegram accounts
            </Link>
          }
        >
          Looking things up on Telegram needs a connected account that is
          allowed to research and is in good standing.
        </Notice>
      )}

      {usable.length > 1 && (
        <div className="max-w-xs">
          <SelectField
            label="Look up with"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </SelectField>
        </div>
      )}

      {tab === 'directory' ? (
        <Directory key={bump} accountId={accountId} canRun={canRun} />
      ) : (
        <Find
          accountId={accountId}
          canRun={canRun}
          onSaved={() => setBump((b) => b + 1)}
        />
      )}
    </PageShell>
  );
};
