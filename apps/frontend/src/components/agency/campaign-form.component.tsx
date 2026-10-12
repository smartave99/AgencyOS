'use client';

import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { useHotkeys } from 'react-hotkeys-hook';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { MediaBox } from '@gitroom/frontend/components/media/media.component';
import { useMediaDirectory } from '@gitroom/react/helpers/use.media.directory';
import {
  CampaignDetail,
  DestinationView,
  useAgencyApi,
  useCampaign,
  useCan,
  useClients,
  useTelegramDestinations,
} from './agency.hooks';
import {
  Btn,
  Card,
  inputClass,
  labelClass,
  Loading,
  PageShell,
  StatusBadge,
  humanize,
} from './agency.ui';

interface Media {
  id: string;
  path: string;
}

export interface Preview {
  html: string;
  visibleLength: number;
  format: string;
  limits: { message: number; caption: number };
  problem: string | null;
}

const OBJECTIVES = [
  'BRAND_AWARENESS',
  'LEAD_GENERATION',
  'TRAFFIC',
  'SALES',
  'COMMUNITY_GROWTH',
];

const EDITABLE = ['DRAFT', 'CHANGES_REQUESTED'];

const FORMAT_TEXT: Record<string, string> = {
  TEXT: 'Sent as one text message',
  MEDIA_WITH_CAPTION:
    'Sent as one post: the media with this text as its caption',
  MEDIA_THEN_TEXT:
    'Text is longer than a caption allows, so it is sent right after the media as a reply',
  ALBUM_WITH_CAPTION: 'Sent as an album, with this text as the first caption',
  ALBUM_THEN_TEXT:
    'Sent as an album followed by the text, which is too long for a caption',
};

const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
};

const parseMedia = (raw: string | null): Media[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((m: any, i: number) =>
        typeof m === 'string'
          ? { id: `m${i}`, path: m }
          : { id: m.id ?? `m${i}`, path: m.path ?? m.url }
      )
      .filter((m: Media) => !!m.path);
  } catch {
    return raw ? [{ id: 'm0', path: raw }] : [];
  }
};

const useTimezones = () =>
  useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf('timeZone') as string[];
    } catch {
      return [
        'UTC',
        'America/New_York',
        'Europe/London',
        'Asia/Dubai',
        'Asia/Kolkata',
      ];
    }
  }, []);

const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const MediaSection: FC<{
  media: Media[];
  onChange: (m: Media[]) => void;
}> = ({ media, onChange }) => {
  const modals = useModals();
  const dir = useMediaDirectory();
  const open = () =>
    modals.openModal({
      title: 'Media library',
      askClose: false,
      closeOnEscape: true,
      fullScreen: true,
      size: 'calc(100% - 80px)',
      height: 'calc(100% - 80px)',
      children: (close) => (
        <MediaBox
          setMedia={(picked) => {
            const seen = new Set(media.map((m) => m.path));
            onChange([
              ...media,
              ...picked
                .filter((p) => !seen.has(p.path))
                .map((p) => ({ id: p.id, path: p.path })),
            ]);
            close();
          }}
          closeModal={close}
        />
      ),
    });

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className={labelClass}>Images or video (optional)</label>
        <Btn type="button" onClick={open}>
          {media.length ? 'Add more' : 'Upload or choose'}
        </Btn>
      </div>
      {media.length > 0 && (
        <ul className="grid grid-cols-4 gap-2 mt-2">
          {media.map((m) => (
            <li
              key={m.path}
              className="relative aspect-square rounded-lg overflow-hidden border border-newBgLineColor bg-newBgColor"
            >
              {/\.(mp4|mov|webm|m4v)(\?|$)/i.test(m.path) ? (
                <video
                  src={dir.set(m.path)}
                  className="w-full h-full object-cover"
                  muted
                />
              ) : (
                <img
                  src={dir.set(m.path)}
                  alt=""
                  className="w-full h-full object-cover"
                />
              )}
              <button
                type="button"
                aria-label="Remove media"
                onClick={() => onChange(media.filter((x) => x.path !== m.path))}
                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] leading-5"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {media.length > 10 && (
        <p className="text-[11px] text-rose-400 mt-1">
          Telegram allows at most 10 files per post.
        </p>
      )}
    </div>
  );
};

export const TelegramPreview: FC<{
  preview: Preview | null;
  media: Media[];
}> = ({ preview, media }) => {
  const dir = useMediaDirectory();
  return (
    <Card
      title="Preview"
      subtitle="Rendered by the same code that sends the post."
      right={
        preview && (
          <span
            className={clsx(
              'text-[11px] font-mono',
              preview.visibleLength > preview.limits.message
                ? 'text-rose-400'
                : 'text-textItemBlur'
            )}
          >
            {preview.visibleLength} / {preview.limits.message}
          </span>
        )
      }
    >
      <div className="rounded-xl bg-[#0e1621] p-4 min-h-[220px] flex flex-col gap-2 border border-slate-800">
        <div className="bg-[#182533] rounded-2xl rounded-tl-sm p-3.5 max-w-[95%] self-start shadow-md flex flex-col gap-2 text-white">
          {media.length > 0 && (
            <div
              className={clsx(
                'grid gap-1',
                media.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
              )}
            >
              {media
                .slice(0, 4)
                .map((m) =>
                  /\.(mp4|mov|webm|m4v)(\?|$)/i.test(m.path) ? (
                    <video
                      key={m.path}
                      src={dir.set(m.path)}
                      className="rounded-lg w-full"
                      muted
                    />
                  ) : (
                    <img
                      key={m.path}
                      src={dir.set(m.path)}
                      alt=""
                      className="rounded-lg w-full"
                    />
                  )
                )}
            </div>
          )}
          {preview && preview.html ? (
            <div
              className="text-xs text-slate-100 whitespace-pre-wrap leading-relaxed break-words [&_a]:text-sky-400 [&_a]:underline [&_code]:font-mono"
              // Server-built HTML: everything user-supplied is escaped, and only a fixed set of
              // formatting tags plus a validated http(s) link survive (see TelegramGateway).
              dangerouslySetInnerHTML={{ __html: preview.html }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a')) e.preventDefault();
              }}
            />
          ) : (
            <div className="text-xs text-slate-400">
              Your ad will appear here as you type.
            </div>
          )}
        </div>
      </div>
      {preview?.problem && (
        <p role="alert" className="text-xs text-rose-400">
          {preview.problem}
        </p>
      )}
      {preview && !preview.problem && preview.html && (
        <p className="text-[11px] text-textItemBlur">
          {FORMAT_TEXT[preview.format]}.
        </p>
      )}
    </Card>
  );
};

export const CampaignFormComponent: FC<{ campaignId?: string }> = ({
  campaignId,
}) => {
  const api = useAgencyApi();
  const router = useRouter();
  const toaster = useToaster();
  const search = useSearchParams();
  const { can, isLoading: roleLoading } = useCan();
  const timezones = useTimezones();
  const { data: clients } = useClients();
  const { data: destinations } = useTelegramDestinations();
  const { data: existing } = useCampaign(campaignId ?? '');

  const [name, setName] = useState('');
  const [customerId, setCustomerId] = useState(search.get('client') || '');
  const [objective, setObjective] = useState('BRAND_AWARENESS');
  const [budget, setBudget] = useState('');
  const [contentTitle, setContentTitle] = useState('');
  const [contentBody, setContentBody] = useState('');
  const [ctaLink, setCtaLink] = useState('');
  const [ctaText, setCtaText] = useState('Learn more');
  const [channelLink, setChannelLink] = useState('');
  const [media, setMedia] = useState<Media[]>([]);
  const [notes, setNotes] = useState('');
  const [needsClient, setNeedsClient] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'submit' | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  // --- AI assist -----------------------------------------------------------
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBrief, setAiBrief] = useState('');
  const [aiTone, setAiTone] = useState('DIRECT_RESPONSE');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<{
    headlines: string[];
    bodyVariants: string[];
    callToActions: string[];
    providerUsed: string;
  } | null>(null);

  // --- hydrate when editing --------------------------------------------------
  const hydrated = useRef(false);
  useEffect(() => {
    if (!campaignId || !existing || hydrated.current) return;
    hydrated.current = true;
    setName(existing.name);
    setCustomerId(existing.customer.id);
    setObjective(existing.objective);
    setBudget(existing.budget ? String(Number(existing.budget)) : '');
    setContentTitle(existing.contentTitle ?? '');
    setContentBody(existing.contentBody);
    setCtaLink(existing.ctaLink ?? '');
    setCtaText(existing.ctaText ?? 'Learn more');
    setChannelLink(existing.telegramChannelLink ?? '');
    setMedia(parseMedia(existing.contentMedia));
    setNotes(existing.internalNotes ?? '');
    setNeedsClient(existing.requiresClientApproval);
    setPicked(
      existing.destinations
        .filter((d) => d.telegramDestination)
        .map((d) => d.telegramDestination!.id)
    );
    setStartDate(toLocalInput(existing.startDate));
    setEndDate(toLocalInput(existing.endDate));
  }, [campaignId, existing]);

  // --- live preview, rendered by the server -----------------------------------
  const mediaKey = media.map((m) => m.path).join('\n');
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .post<Preview>('/agency/campaigns/preview', {
          contentTitle,
          contentBody,
          ctaLink: isHttpUrl(ctaLink) ? ctaLink : undefined,
          ctaText,
          telegramChannelLink: isHttpUrl(channelLink) ? channelLink : undefined,
          media: mediaKey ? mediaKey.split('\n') : [],
        })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [contentTitle, contentBody, ctaLink, ctaText, channelLink, mediaKey, api]);

  // --- validation, shown as you go --------------------------------------------
  const errors = {
    customer: customerId ? null : 'Choose the client this campaign is for.',
    name: name.trim() ? null : 'Give the campaign a name.',
    body: contentBody.trim() ? null : 'Write the ad text.',
    cta:
      ctaLink && !isHttpUrl(ctaLink)
        ? 'Enter a full link starting with https://'
        : null,
    channel:
      channelLink && !isHttpUrl(channelLink)
        ? 'Enter a full link starting with https://'
        : null,
    budget: budget && Number(budget) < 0 ? 'Budget cannot be negative.' : null,
    dates:
      startDate && endDate && new Date(endDate) <= new Date(startDate)
        ? 'The end must be after the start.'
        : null,
    media:
      media.length > 10 ? 'Telegram allows at most 10 files per post.' : null,
  };
  const show = (e: string | null) => (tried ? e : null);
  const draftBlockers = [
    errors.customer,
    errors.name,
    errors.body,
    errors.cta,
    errors.channel,
    errors.budget,
    errors.dates,
    errors.media,
  ].filter(Boolean);
  const submitBlockers = [
    ...draftBlockers,
    picked.length === 0 ? 'Choose at least one authorized destination.' : null,
    startDate ? null : 'Pick when it should start.',
    preview?.problem ?? null,
  ].filter(Boolean) as string[];

  const usable = (d: DestinationView) => d.authorizationStatus === 'ACTIVE';

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const save = async (submit: boolean) => {
    setTried(true);
    if ((submit ? submitBlockers : draftBlockers).length > 0) {
      toaster.show(
        'A few things need fixing first. They are marked in the form.',
        'warning'
      );
      return;
    }
    setBusy(submit ? 'submit' : 'draft');
    let id = campaignId;
    try {
      const body = {
        name: name.trim(),
        objective,
        budget: budget ? Number(budget) : undefined,
        startDate: startDate ? new Date(startDate).toISOString() : undefined,
        endDate: endDate ? new Date(endDate).toISOString() : undefined,
        timezone,
        contentTitle: contentTitle.trim(),
        contentBody: contentBody.trim(),
        contentMedia: JSON.stringify(media),
        ctaLink: ctaLink.trim(),
        ctaText: ctaText.trim(),
        telegramChannelLink: channelLink.trim(),
        internalNotes: notes.trim(),
        requiresClientApproval: needsClient,
      };
      const destinationsBody = picked.map((tid) => ({
        destinationType: 'TELEGRAM' as const,
        telegramDestinationId: tid,
      }));
      if (id) {
        await api.put(`/agency/campaigns/${id}`, body);
        await api.put(`/agency/campaigns/${id}/destinations`, {
          destinations: destinationsBody,
        });
      } else {
        const created = await api.post<{ id: string }>('/agency/campaigns', {
          ...body,
          customerId,
          destinations: destinationsBody,
        });
        id = created.id;
      }
    } catch (e: any) {
      toaster.show(e.message, 'warning');
      setBusy(null);
      return;
    }

    if (submit) {
      try {
        await api.post(`/agency/campaigns/${id}/submit`, {
          notes: 'Submitted from the composer',
        });
        toaster.show('Submitted. A manager can review it now.', 'success');
      } catch (e: any) {
        // Saved, but not submitted: say exactly that, and take them where they can fix it.
        toaster.show(
          `Saved as a draft, but it was not submitted: ${e.message}`,
          'warning'
        );
      }
    } else {
      toaster.show('Draft saved.', 'success');
    }
    router.push(`/agency/campaigns/${id}`);
  };

  useHotkeys('mod+s', () => void save(false), {
    preventDefault: true,
    enableOnFormTags: true,
  });

  const generate = async () => {
    if (aiBrief.trim().length < 5) {
      toaster.show(
        'Describe the product or offer in a sentence or two.',
        'warning'
      );
      return;
    }
    setAiBusy(true);
    try {
      const client = clients?.find((c) => c.id === customerId);
      setAiResult(
        await api.post('/agency/ai/generate-copy', {
          brief: aiBrief.trim(),
          clientName: client?.companyName || client?.name,
          objective,
          tone: aiTone,
          channelType: 'TELEGRAM',
        })
      );
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    } finally {
      setAiBusy(false);
    }
  };

  if (roleLoading) return <Loading />;
  if (!can('campaign:write')) {
    return (
      <PageShell>
        <p className="text-sm text-newTextColor">
          Your role can view campaigns but not create or edit them.
        </p>
      </PageShell>
    );
  }
  if (campaignId && existing && !EDITABLE.includes(existing.status)) {
    return (
      <PageShell>
        <p className="text-sm text-newTextColor">
          This campaign is <StatusBadge status={existing.status} /> and its
          content is locked so that what was reviewed is what gets sent. Reopen
          it from the campaign page to edit.
        </p>
        <Link
          href={`/agency/campaigns/${campaignId}`}
          className="text-blue-400 text-xs hover:underline"
        >
          ← Back to the campaign
        </Link>
      </PageShell>
    );
  }

  const checklist: Array<[string, boolean]> = [
    ['Client chosen', !errors.customer],
    ['Ad text written', !errors.body],
    ['Fits Telegram’s limits', !!preview && !preview.problem],
    ['At least one authorized destination', picked.length > 0],
    ['Start time set', !!startDate],
  ];

  return (
    <PageShell>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-newBgLineColor pb-4">
        <div>
          <Link
            href={
              campaignId
                ? `/agency/campaigns/${campaignId}`
                : '/agency/campaigns'
            }
            className="text-xs text-blue-400 hover:underline"
          >
            ← {campaignId ? 'Back to the campaign' : 'All campaigns'}
          </Link>
          <h1 className="text-xl font-bold text-newTextColor mt-1">
            {campaignId ? 'Edit campaign' : 'New campaign'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Btn
            busy={busy === 'draft'}
            disabled={busy !== null}
            onClick={() => save(false)}
          >
            Save draft
          </Btn>
          <Btn
            variant="primary"
            busy={busy === 'submit'}
            disabled={busy !== null}
            onClick={() => save(true)}
          >
            Submit for review
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 flex flex-col gap-6">
          <Card title="1 · The brief">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="client" className={labelClass}>
                  Client *
                </label>
                <select
                  id="client"
                  className={inputClass}
                  value={customerId}
                  disabled={!!campaignId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  aria-invalid={!!show(errors.customer)}
                >
                  <option value="">Choose a client…</option>
                  {(clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.companyName || c.name}
                    </option>
                  ))}
                </select>
                {show(errors.customer) && (
                  <p className="text-[11px] text-rose-400 mt-1">
                    {errors.customer}
                  </p>
                )}
                {clients && clients.length === 0 && (
                  <p className="text-[11px] text-textItemBlur mt-1">
                    No clients yet.{' '}
                    <Link
                      href="/agency/clients"
                      className="text-blue-400 hover:underline"
                    >
                      Add one first
                    </Link>
                    .
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="name" className={labelClass}>
                  Campaign name *
                </label>
                <input
                  id="name"
                  className={inputClass}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Spring offer"
                  aria-invalid={!!show(errors.name)}
                />
                {show(errors.name) && (
                  <p className="text-[11px] text-rose-400 mt-1">
                    {errors.name}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="objective" className={labelClass}>
                  Objective
                </label>
                <select
                  id="objective"
                  className={inputClass}
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                >
                  {OBJECTIVES.map((o) => (
                    <option key={o} value={o}>
                      {humanize(o)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="budget" className={labelClass}>
                  Budget (optional)
                </label>
                <input
                  id="budget"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="1500"
                />
                {show(errors.budget) && (
                  <p className="text-[11px] text-rose-400 mt-1">
                    {errors.budget}
                  </p>
                )}
              </div>
            </div>
          </Card>

          <Card
            title="2 · The ad"
            right={
              <Btn
                type="button"
                variant="ghost"
                onClick={() => setAiOpen((v) => !v)}
              >
                {aiOpen ? 'Hide writing help' : 'Help me write it'}
              </Btn>
            }
          >
            {aiOpen && (
              <div className="rounded-xl border border-newBgLineColor bg-newBgColor p-3 flex flex-col gap-2">
                <textarea
                  rows={2}
                  className={inputClass + ' resize-none'}
                  placeholder="What are we advertising, and to whom?"
                  value={aiBrief}
                  onChange={(e) => setAiBrief(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <select
                    className={inputClass + ' w-auto'}
                    value={aiTone}
                    onChange={(e) => setAiTone(e.target.value)}
                  >
                    <option value="DIRECT_RESPONSE">Direct</option>
                    <option value="PROFESSIONAL">Professional</option>
                    <option value="CASUAL">Casual</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                  <Btn type="button" busy={aiBusy} onClick={generate}>
                    Suggest copy
                  </Btn>
                </div>
                {aiResult && (
                  <div className="flex flex-col gap-2 text-xs">
                    <p className="text-textItemBlur">
                      {aiResult.providerUsed === 'heuristic_engine'
                        ? 'Template draft. No AI model was reachable, so these are fill-in-the-blank suggestions. Edit freely.'
                        : `Written by ${aiResult.providerUsed}. Review before using.`}
                    </p>
                    {aiResult.headlines.slice(0, 3).map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setContentTitle(h)}
                        className="text-left rounded-lg border border-newBgLineColor px-2.5 py-1.5 hover:border-blue-500 text-newTextColor"
                      >
                        <span className="text-[10px] uppercase text-textItemBlur">
                          Headline ·{' '}
                        </span>
                        {h}
                      </button>
                    ))}
                    {aiResult.bodyVariants.slice(0, 3).map((b) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => setContentBody(b)}
                        className="text-left rounded-lg border border-newBgLineColor px-2.5 py-1.5 hover:border-blue-500 text-newTextColor whitespace-pre-wrap"
                      >
                        <span className="text-[10px] uppercase text-textItemBlur">
                          Text ·{' '}
                        </span>
                        {b}
                      </button>
                    ))}
                    {aiResult.callToActions.slice(0, 3).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCtaText(c)}
                        className="text-left rounded-lg border border-newBgLineColor px-2.5 py-1.5 hover:border-blue-500 text-newTextColor"
                      >
                        <span className="text-[10px] uppercase text-textItemBlur">
                          Button text ·{' '}
                        </span>
                        {c}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div>
              <label htmlFor="title" className={labelClass}>
                Headline (optional)
              </label>
              <input
                id="title"
                className={inputClass}
                value={contentTitle}
                onChange={(e) => setContentTitle(e.target.value)}
                placeholder="Fresh fruit, delivered"
              />
            </div>
            <div>
              <label htmlFor="body" className={labelClass}>
                Ad text *
              </label>
              <textarea
                id="body"
                rows={7}
                className={inputClass + ' resize-y'}
                value={contentBody}
                onChange={(e) => setContentBody(e.target.value)}
                placeholder="Write what people should read. You can use <b>bold</b>, <i>italic</i>, <u>underline</u> and <code>code</code>."
                aria-invalid={!!show(errors.body)}
              />
              {show(errors.body) && (
                <p className="text-[11px] text-rose-400 mt-1">{errors.body}</p>
              )}
            </div>
            <MediaSection media={media} onChange={setMedia} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cta" className={labelClass}>
                  Link (optional)
                </label>
                <input
                  id="cta"
                  className={inputClass}
                  value={ctaLink}
                  onChange={(e) => setCtaLink(e.target.value)}
                  placeholder="https://example.com/offer"
                  aria-invalid={!!errors.cta}
                />
                {errors.cta && ctaLink && (
                  <p className="text-[11px] text-rose-400 mt-1">{errors.cta}</p>
                )}
              </div>
              <div>
                <label htmlFor="ctatext" className={labelClass}>
                  Link text
                </label>
                <input
                  id="ctatext"
                  className={inputClass}
                  value={ctaText}
                  onChange={(e) => setCtaText(e.target.value)}
                />
              </div>
            </div>
          </Card>

          <Card
            title="3 · Where it posts"
            subtitle="Only destinations whose admins authorized you can be chosen."
          >
            {!destinations ? (
              <Loading />
            ) : destinations.length === 0 ? (
              <p className="text-xs text-textItemBlur">
                No destinations yet.{' '}
                <Link
                  href="/agency/telegram"
                  className="text-blue-400 hover:underline"
                >
                  Connect a group or channel
                </Link>
                .
              </p>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {destinations.map((d) => {
                  const ok = usable(d);
                  return (
                    <li key={d.id}>
                      <label
                        className={clsx(
                          'p-3 rounded-lg border flex items-start gap-2.5 transition-all',
                          ok
                            ? 'cursor-pointer'
                            : 'opacity-60 cursor-not-allowed',
                          picked.includes(d.id)
                            ? 'bg-blue-600/10 border-blue-500/40'
                            : 'bg-newBgColor border-newBgLineColor'
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          disabled={!ok}
                          checked={picked.includes(d.id)}
                          onChange={() => toggle(d.id)}
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-newTextColor truncate">
                            {d.title}
                          </div>
                          <div className="mt-1">
                            <StatusBadge status={d.authorizationStatus} />
                          </div>
                          {!ok && (
                            <div className="text-[11px] text-textItemBlur mt-1">
                              Can’t be used until a group admin authorizes it.
                            </div>
                          )}
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[11px] text-textItemBlur">
              Social accounts aren’t dispatched from campaigns yet. Schedule
              those from{' '}
              <Link href="/launches" className="text-blue-400 hover:underline">
                Launches
              </Link>
              .
            </p>
          </Card>

          <Card title="4 · When">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="start" className={labelClass}>
                  Start *
                </label>
                <input
                  id="start"
                  type="datetime-local"
                  className={inputClass}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
                <p className="text-[11px] text-textItemBlur mt-1">
                  Posts once to each destination at this time (or right away if
                  it’s already past).
                </p>
              </div>
              <div>
                <label htmlFor="end" className={labelClass}>
                  Stop sending after (optional)
                </label>
                <input
                  id="end"
                  type="datetime-local"
                  className={inputClass}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  aria-invalid={!!errors.dates}
                />
                {errors.dates && (startDate || endDate) && (
                  <p className="text-[11px] text-rose-400 mt-1">
                    {errors.dates}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              className="text-xs text-blue-400 hover:underline self-start"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? 'Hide advanced' : 'Advanced options'}
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-3">
                <div>
                  <label htmlFor="tz" className={labelClass}>
                    Time zone
                  </label>
                  <input
                    id="tz"
                    list="tz-list"
                    className={inputClass}
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                  <datalist id="tz-list">
                    {timezones.map((z) => (
                      <option key={z} value={z} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label htmlFor="channel" className={labelClass}>
                    Community link (optional)
                  </label>
                  <input
                    id="channel"
                    className={inputClass}
                    value={channelLink}
                    onChange={(e) => setChannelLink(e.target.value)}
                    placeholder="https://t.me/yourcommunity"
                    aria-invalid={!!errors.channel}
                  />
                  {errors.channel && channelLink && (
                    <p className="text-[11px] text-rose-400 mt-1">
                      {errors.channel}
                    </p>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs text-newTextColor">
                  <input
                    type="checkbox"
                    checked={needsClient}
                    onChange={(e) => setNeedsClient(e.target.checked)}
                  />
                  The client must approve this before we can
                </label>
                <div>
                  <label htmlFor="notes" className={labelClass}>
                    Internal notes
                  </label>
                  <textarea
                    id="notes"
                    rows={2}
                    className={inputClass + ' resize-none'}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Only your team sees this."
                  />
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-4 lg:sticky lg:top-4 self-start">
          <TelegramPreview preview={preview} media={media} />
          <Card title="Ready to submit?">
            <ul className="flex flex-col gap-1.5">
              {checklist.map(([label, ok]) => (
                <li key={label} className="flex items-center gap-2 text-xs">
                  <span
                    className={ok ? 'text-emerald-400' : 'text-textItemBlur'}
                  >
                    {ok ? '✓' : '○'}
                  </span>
                  <span
                    className={ok ? 'text-newTextColor' : 'text-textItemBlur'}
                  >
                    {label}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-textItemBlur">
              Submitting sends it to the approval inbox. Nothing is posted until
              a manager approves it and it is scheduled. Press ⌘/Ctrl + S to
              save a draft.
            </p>
          </Card>
        </div>
      </div>
    </PageShell>
  );
};

export type { CampaignDetail };
