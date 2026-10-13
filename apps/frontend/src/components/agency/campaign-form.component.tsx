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
  AdTemplate,
  CampaignDetail,
  DestinationView,
  useAgencyApi,
  useCampaign,
  useCan,
  useClients,
  useTelegramDestinations,
} from './agency.hooks';
import { TemplatesDialog } from './templates.dialog.component';
import {
  Btn,
  Card,
  CheckField,
  EmptyState,
  Icon,
  LinkBtn,
  Loading,
  PageHeader,
  PageShell,
  SelectField,
  StatusBadge,
  TextArea,
  TextField,
  TONE_TEXT,
  humanize,
  inputClass,
  labelClass,
  useTouched,
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

const isVideo = (path: string) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(path);

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
        <span className={labelClass + ' !mb-0'}>
          Images or video
          <span className="font-normal text-textItemBlur/70"> · optional</span>
        </span>
        <Btn type="button" onClick={open}>
          <Icon name="plus" size={14} />
          {media.length ? 'Add more' : 'Add media'}
        </Btn>
      </div>
      {media.length > 0 && (
        <ul className="grid grid-cols-4 sm:grid-cols-5 gap-2 mt-3">
          {media.map((m) => (
            <li
              key={m.path}
              className="group relative aspect-square rounded-xl overflow-hidden border border-[color:var(--ag-hairline)] bg-newBgColor"
            >
              {isVideo(m.path) ? (
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
                className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {media.length > 10 && (
        <p className={clsx('mt-2 text-xs', TONE_TEXT.bad)}>
          Telegram allows at most 10 files per post.
        </p>
      )}
    </div>
  );
};

/**
 * The ad exactly as Telegram will show it. The HTML is built by the same server code
 * that sends the post, so the preview cannot drift from the real thing. It is drawn in
 * Telegram's own dark palette in both themes, like a device mock.
 */
export const TelegramBubble: FC<{
  html: string | null | undefined;
  media: Media[];
  empty?: string;
}> = ({ html, media, empty = 'Your ad will appear here as you type.' }) => {
  const dir = useMediaDirectory();
  return (
    <div className="rounded-2xl bg-[#0e1621] p-4 min-h-[160px] flex flex-col gap-2 ring-1 ring-black/20">
      <div className="bg-[#182533] rounded-2xl rounded-tl-md p-3.5 max-w-[95%] self-start shadow-lg flex flex-col gap-2 text-white">
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
                isVideo(m.path) ? (
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
        {html ? (
          <div
            className="text-[13px] text-slate-100 whitespace-pre-wrap leading-relaxed break-words [&_a]:text-sky-400 [&_a]:underline [&_code]:font-mono"
            // Server-built HTML: everything user-supplied is escaped, and only a fixed set of
            // formatting tags plus a validated http(s) link survive (see TelegramGateway).
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('a')) e.preventDefault();
            }}
          />
        ) : (
          <div className="text-[13px] text-slate-400">{empty}</div>
        )}
      </div>
    </div>
  );
};

export const TelegramPreview: FC<{
  preview: Preview | null;
  media: Media[];
}> = ({ preview, media }) => (
  <Card
    title="Preview"
    subtitle="Rendered by the same code that sends the post."
    right={
      preview && (
        <span
          className={clsx(
            'text-xs tabular-nums',
            preview.visibleLength > preview.limits.message
              ? TONE_TEXT.bad
              : 'text-textItemBlur'
          )}
        >
          {preview.visibleLength} / {preview.limits.message}
        </span>
      )
    }
  >
    <TelegramBubble html={preview?.html} media={media} />
    {preview?.problem && (
      <p role="alert" className={clsx('text-[13px]', TONE_TEXT.bad)}>
        {preview.problem}
      </p>
    )}
    {preview && !preview.problem && preview.html && (
      <p className="text-xs text-textItemBlur">
        {FORMAT_TEXT[preview.format]}.
      </p>
    )}
  </Card>
);

const Step: FC<{ n: number; title: string; subtitle?: string }> = ({
  n,
  title,
  subtitle,
}) => (
  <div className="flex items-center gap-3">
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ag-accent-soft)] text-xs font-semibold text-[color:var(--ag-accent-text)]">
      {n}
    </span>
    <div>
      <h2 className="text-[15px] font-semibold tracking-tight text-newTextColor">
        {title}
      </h2>
      {subtitle && <p className="text-[13px] text-textItemBlur">{subtitle}</p>}
    </div>
  </div>
);

export const CampaignFormComponent: FC<{ campaignId?: string }> = ({
  campaignId,
}) => {
  const api = useAgencyApi();
  const router = useRouter();
  const toaster = useToaster();
  const search = useSearchParams();
  const { can, isLoading: roleLoading } = useCan();
  const timezones = useTimezones();
  const touched = useTouched();
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

  const [templatesOpen, setTemplatesOpen] = useState(false);

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
    model?: string | null;
    fallbackReason?: string;
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

  // --- validation: shown once a field is touched, and everywhere after a failed save
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
  const err = (key: keyof typeof errors) =>
    tried ? errors[key] ?? undefined : touched.show(key, errors[key]);

  const draftBlockers = Object.values(errors).filter(Boolean);
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
    } catch (e) {
      toaster.show((e as Error).message, 'warning');
      setBusy(null);
      return;
    }

    if (submit) {
      try {
        await api.post(`/agency/campaigns/${id}/submit`, {
          notes: 'Submitted from the composer',
        });
        toaster.show('Submitted. A manager can review it now.', 'success');
      } catch (e) {
        // Saved, but not submitted: say exactly that, and take them where they can fix it.
        toaster.show(
          `Saved as a draft, but it was not submitted: ${(e as Error).message}`,
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

  /** Fills the ad from a saved template. It changes nothing else about the campaign. */
  const applyTemplate = (template: AdTemplate) => {
    setContentTitle(template.contentTitle ?? '');
    setContentBody(template.contentBody);
    setMedia(parseMedia(template.contentMedia));
    setCtaLink(template.ctaLink ?? '');
    setCtaText(template.ctaText ?? 'Learn more');
    toaster.show(`Started from “${template.name}”.`, 'success');
  };

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
    } catch (e) {
      toaster.show((e as Error).message, 'warning');
    } finally {
      setAiBusy(false);
    }
  };

  if (roleLoading) {
    return (
      <PageShell>
        <Loading />
      </PageShell>
    );
  }
  if (!can('campaign:write')) {
    return (
      <PageShell>
        <PageHeader
          back={{ href: '/agency/campaigns', label: 'Campaigns' }}
          title="New campaign"
        />
        <p className="text-[13px] text-textItemBlur">
          Your role can view campaigns but not create or edit them.
        </p>
      </PageShell>
    );
  }
  if (campaignId && existing && !EDITABLE.includes(existing.status)) {
    return (
      <PageShell>
        <PageHeader
          back={{ href: `/agency/campaigns/${campaignId}`, label: 'Campaign' }}
          title="This campaign is locked"
          badge={<StatusBadge status={existing.status} />}
        />
        <p className="max-w-xl text-[13px] leading-relaxed text-textItemBlur">
          Its content is locked so that what was reviewed is what gets sent.
          Reopen it from the campaign page to edit.
        </p>
      </PageShell>
    );
  }

  const checklist: Array<[string, boolean]> = [
    ['Client chosen', !errors.customer],
    ['Ad text written', !errors.body],
    ['Fits Telegram’s limits', !errors.body && !!preview && !preview.problem],
    ['At least one authorized destination', picked.length > 0],
    ['Start time set', !!startDate],
  ];
  const ready = checklist.every(([, ok]) => ok);

  const suggestion = (kind: string, text: string, apply: () => void) => (
    <button
      key={`${kind}-${text}`}
      type="button"
      onClick={apply}
      className="text-left rounded-xl border border-[color:var(--ag-hairline)] bg-newBgColorInner px-3 py-2.5 hover:border-[color:var(--ag-accent)] text-[13px] text-newTextColor whitespace-pre-wrap"
    >
      <span className="block text-[11px] font-medium text-textItemBlur mb-0.5">
        {kind}
      </span>
      {text}
    </button>
  );

  return (
    <PageShell>
      <PageHeader
        back={
          campaignId
            ? { href: `/agency/campaigns/${campaignId}`, label: 'Campaign' }
            : { href: '/agency/campaigns', label: 'Campaigns' }
        }
        title={campaignId ? 'Edit campaign' : 'New campaign'}
        actions={
          <>
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
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 flex flex-col gap-6 min-w-0">
          <Card>
            <Step n={1} title="The brief" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <SelectField
                label="Client"
                value={customerId}
                disabled={!!campaignId}
                onChange={(e) => setCustomerId(e.target.value)}
                onBlur={touched.blur('customer')}
                error={err('customer')}
                hint={
                  clients && clients.length === 0
                    ? 'No clients yet. Add one on the Clients page first.'
                    : undefined
                }
              >
                <option value="">Choose a client…</option>
                {(clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.companyName || c.name}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Campaign name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={touched.blur('name')}
                error={err('name')}
                placeholder="Spring offer"
              />
              <SelectField
                label="Objective"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              >
                {OBJECTIVES.map((o) => (
                  <option key={o} value={o}>
                    {humanize(o)}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Budget"
                optional
                type="number"
                min={0}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                onBlur={touched.blur('budget')}
                error={err('budget')}
                placeholder="1500"
              />
            </div>
          </Card>

          <Card>
            <div className="flex items-start justify-between gap-3">
              <Step n={2} title="The ad" />
              <div className="flex flex-wrap justify-end gap-1">
                <Btn variant="ghost" onClick={() => setTemplatesOpen(true)}>
                  Templates
                </Btn>
                <Btn variant="ghost" onClick={() => setAiOpen((v) => !v)}>
                  {aiOpen ? 'Hide writing help' : 'Help me write it'}
                </Btn>
              </div>
            </div>

            {aiOpen && (
              <div className="ag-rise rounded-xl bg-[var(--ag-neutral-bg)] p-4 flex flex-col gap-3">
                <TextArea
                  label="What are we advertising, and to whom?"
                  rows={2}
                  value={aiBrief}
                  onChange={(e) => setAiBrief(e.target.value)}
                />
                <div className="flex flex-wrap items-end gap-3">
                  <SelectField
                    label="Tone"
                    wrapperClassName="w-44"
                    value={aiTone}
                    onChange={(e) => setAiTone(e.target.value)}
                  >
                    <option value="DIRECT_RESPONSE">Direct</option>
                    <option value="PROFESSIONAL">Professional</option>
                    <option value="CASUAL">Casual</option>
                    <option value="URGENT">Urgent</option>
                  </SelectField>
                  <Btn busy={aiBusy} onClick={generate}>
                    Suggest copy
                  </Btn>
                </div>
                {aiResult && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-textItemBlur">
                      {aiResult.providerUsed === 'heuristic_engine'
                        ? `Template draft: these are fill-in-the-blank suggestions, not written by a model. ${
                            aiResult.fallbackReason ?? ''
                          } Edit freely.`
                        : `Written by ${
                            aiResult.model ?? aiResult.providerUsed
                          }. Review before using.`}
                      {aiResult.providerUsed === 'heuristic_engine' && (
                        <>
                          {' '}
                          <Link
                            href="/settings?tab=ai"
                            className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
                          >
                            Check AI settings
                          </Link>
                        </>
                      )}
                    </p>
                    {aiResult.headlines
                      .slice(0, 3)
                      .map((h) =>
                        suggestion('Headline', h, () => setContentTitle(h))
                      )}
                    {aiResult.bodyVariants
                      .slice(0, 3)
                      .map((b) =>
                        suggestion('Text', b, () => setContentBody(b))
                      )}
                    {aiResult.callToActions
                      .slice(0, 3)
                      .map((c) =>
                        suggestion('Button text', c, () => setCtaText(c))
                      )}
                  </div>
                )}
              </div>
            )}

            <TextField
              label="Headline"
              optional
              value={contentTitle}
              onChange={(e) => setContentTitle(e.target.value)}
              placeholder="Fresh fruit, delivered"
            />
            <TextArea
              label="Ad text"
              rows={7}
              className="resize-y"
              value={contentBody}
              onChange={(e) => setContentBody(e.target.value)}
              onBlur={touched.blur('body')}
              error={err('body')}
              hint="You can use <b>bold</b>, <i>italic</i>, <u>underline</u> and <code>code</code>."
            />
            <MediaSection media={media} onChange={setMedia} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField
                label="Link"
                optional
                value={ctaLink}
                onChange={(e) => setCtaLink(e.target.value)}
                onBlur={touched.blur('cta')}
                error={err('cta')}
                placeholder="https://example.com/offer"
              />
              <TextField
                label="Link text"
                value={ctaText}
                onChange={(e) => setCtaText(e.target.value)}
              />
            </div>
          </Card>

          <Card>
            <Step
              n={3}
              title="Where it posts"
              subtitle="Only destinations whose admins authorized you can be chosen."
            />
            {!destinations ? (
              <Loading rows={2} />
            ) : destinations.length === 0 ? (
              <EmptyState
                icon="send"
                title="No destinations yet"
                hint="Connect a group or channel and have its admin authorize it."
                action={
                  <LinkBtn href="/agency/telegram" variant="primary">
                    Connect a chat
                  </LinkBtn>
                }
              />
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {destinations.map((d) => {
                  const ok = usable(d);
                  const on = picked.includes(d.id);
                  return (
                    <li key={d.id}>
                      <label
                        className={clsx(
                          'p-4 rounded-xl border flex items-start gap-3',
                          ok
                            ? 'cursor-pointer'
                            : 'opacity-60 cursor-not-allowed',
                          on
                            ? 'bg-[var(--ag-accent-soft)] border-[color:var(--ag-accent)]'
                            : 'bg-newBgColor border-[color:var(--ag-hairline)] hover:border-[color:var(--ag-neutral-line)]'
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[color:var(--ag-accent)]"
                          disabled={!ok}
                          checked={on}
                          onChange={() => toggle(d.id)}
                        />
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-newTextColor truncate">
                            {d.title}
                          </div>
                          <div className="mt-1.5">
                            <StatusBadge status={d.authorizationStatus} />
                          </div>
                          {!ok && (
                            <div className="text-xs text-textItemBlur mt-1.5">
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
            <p className="text-xs text-textItemBlur">
              Social accounts aren’t dispatched from campaigns yet. Schedule
              those from{' '}
              <Link
                href="/launches"
                className="text-[color:var(--ag-accent-text)] hover:underline"
              >
                Launches
              </Link>
              .
            </p>
          </Card>

          <Card>
            <Step n={4} title="When" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField
                label="Start"
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                hint="Posts once to each destination at this time, or right away if it is already past."
              />
              <TextField
                label="Stop sending after"
                optional
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                onBlur={touched.blur('dates')}
                error={err('dates')}
              />
            </div>
            <button
              type="button"
              aria-expanded={showAdvanced}
              className="inline-flex items-center gap-1 self-start text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <Icon
                name="chevron"
                size={14}
                className={clsx(
                  'transition-transform',
                  showAdvanced && 'rotate-180'
                )}
              />
              {showAdvanced ? 'Hide advanced options' : 'Advanced options'}
            </button>
            {showAdvanced && (
              <div className="ag-rise flex flex-col gap-4">
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
                <TextField
                  label="Community link"
                  optional
                  value={channelLink}
                  onChange={(e) => setChannelLink(e.target.value)}
                  onBlur={touched.blur('channel')}
                  error={err('channel')}
                  placeholder="https://t.me/yourcommunity"
                />
                <CheckField
                  checked={needsClient}
                  onChange={(e) => setNeedsClient(e.target.checked)}
                >
                  The client must approve this before we can
                </CheckField>
                <TextArea
                  label="Internal notes"
                  optional
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Only your team sees this."
                />
              </div>
            )}
          </Card>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6 lg:sticky lg:top-6 self-start min-w-0">
          <TelegramPreview preview={preview} media={media} />
          <Card title={ready ? 'Ready to submit' : 'Before you submit'}>
            <ul className="flex flex-col gap-2">
              {checklist.map(([label, ok]) => (
                <li
                  key={label}
                  className="flex items-center gap-2.5 text-[13px]"
                >
                  <span
                    className={clsx(
                      'flex h-5 w-5 items-center justify-center rounded-full border',
                      ok
                        ? 'bg-[var(--ag-good-bg)] border-[color:var(--ag-good-line)] ' +
                            TONE_TEXT.good
                        : 'border-[color:var(--ag-hairline)] text-transparent'
                    )}
                  >
                    <Icon name="tick" size={11} />
                  </span>
                  <span
                    className={ok ? 'text-newTextColor' : 'text-textItemBlur'}
                  >
                    {label}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-relaxed text-textItemBlur">
              Submitting sends it to the approval inbox. Nothing is posted until
              a manager approves it and it is scheduled. Press ⌘ or Ctrl + S to
              save a draft.
            </p>
          </Card>
        </div>
      </div>
      {templatesOpen && (
        <TemplatesDialog
          current={{
            contentTitle,
            contentBody,
            contentMedia: JSON.stringify(media),
            ctaLink,
            ctaText,
          }}
          onUse={applyTemplate}
          onClose={() => setTemplatesOpen(false)}
        />
      )}
    </PageShell>
  );
};

export type { CampaignDetail };
