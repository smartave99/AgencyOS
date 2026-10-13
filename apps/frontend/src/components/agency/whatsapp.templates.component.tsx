'use client';

import React, { FC, useEffect, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
  useWhatsappContacts,
  useWhatsappFacets,
  useWhatsappSegments,
  useWhatsappSettings,
  useWhatsappTemplates,
  WhatsappContactItem,
  WhatsappSegmentView,
  WhatsappSuggestion,
  WhatsappTemplatePreview,
  WhatsappTemplateView,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  CheckField,
  Dialog,
  EmptyState,
  Icon,
  LoadError,
  Loading,
  Menu,
  Notice,
  SelectField,
  StatusBadge,
  TextArea,
  TextField,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';
import {
  ChipPicker,
  useDebounced,
} from '@gitroom/frontend/components/agency/whatsapp.shared';

const isWebLink = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Prepare messages: one task per person, none of them sent
// ---------------------------------------------------------------------------
export const PrepareDialog: FC<{
  templates: WhatsappTemplateView[];
  segments: WhatsappSegmentView[];
  limit: number;
  templateId?: string;
  segmentId?: string;
  /** One person instead of a segment. */
  contact?: { id: string; name: string };
  onClose: () => void;
  onDone: () => void;
}> = ({
  templates,
  segments,
  limit,
  templateId: presetTemplate,
  segmentId: presetSegment,
  contact,
  onClose,
  onDone,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [templateId, setTemplateId] = useState(
    presetTemplate ?? (templates.length === 1 ? templates[0].id : '')
  );
  const [segmentId, setSegmentId] = useState(presetSegment ?? '');
  const segment = segments.find((s) => s.id === segmentId);

  const segmentProblem = () => {
    if (contact) return null;
    if (!segmentId) return 'Choose who the messages are for.';
    if (!segment) return null;
    if (segment.memberCount === 0) {
      return 'Nobody in this segment has agreed to be contacted yet.';
    }
    if (segment.memberCount > limit) {
      return `That is more than ${limit} people. Narrow the segment: every message is sent by hand.`;
    }
    return null;
  };
  const errors = {
    template: templateId ? null : 'Choose the wording to use.',
    segment: segmentProblem(),
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['template', 'segment']);
    if (errors.template || errors.segment) return;
    await run(async () => {
      try {
        const result = await api.post<{
          created: number;
          skipped: { alreadyWaiting: number; missingDetails: number };
        }>('/agency/whatsapp/tasks/draft', {
          templateId,
          ...(contact ? { contactId: contact.id } : { segmentId }),
        });
        const notes = [
          result.skipped.alreadyWaiting
            ? `${result.skipped.alreadyWaiting} already had this message waiting`
            : '',
          result.skipped.missingDetails
            ? `${result.skipped.missingDetails} lack a detail the wording needs`
            : '',
        ].filter(Boolean);
        toaster.show(
          `${result.created} ${
            result.created === 1 ? 'message is' : 'messages are'
          } ready for you to send${
            notes.length ? `. Left out: ${notes.join('; ')}` : ''
          }.`,
          result.created ? 'success' : 'warning'
        );
        onDone();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="Prepare messages"
      description="This only prepares the wording for each person. Nothing is sent: every message waits in Outreach until you open the chat and send it yourself."
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Prepare messages
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SelectField
          label="Wording"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          onBlur={touched.blur('template')}
          error={touched.show('template', errors.template)}
        >
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
        {contact ? (
          <p className="text-[13px] text-textItemBlur">
            For one person:{' '}
            <span className="text-newTextColor">{contact.name}</span>
          </p>
        ) : (
          <SelectField
            label="Who"
            value={segmentId}
            onChange={(e) => setSegmentId(e.target.value)}
            onBlur={touched.blur('segment')}
            error={touched.show('segment', errors.segment)}
            hint="Only people who agreed to be contacted are in a segment."
          >
            <option value="">Choose a segment…</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.memberCount})
              </option>
            ))}
          </SelectField>
        )}
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// A template: wording with a live preview, an opt-out line, and optional AI help
// ---------------------------------------------------------------------------
const TemplateDialog: FC<{
  template?: WhatsappTemplateView;
  onClose: () => void;
  onSaved: () => void;
}> = ({ template, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const { data: settings } = useWhatsappSettings();
  const { data: people } = useWhatsappContacts('', 'OPTED_IN', '');
  const [name, setName] = useState(template?.name ?? '');
  const [language, setLanguage] = useState(template?.language ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [link, setLink] = useState(template?.link ?? '');
  const [optOut, setOptOut] = useState(
    template
      ? template.optOutLine
      : settings?.defaultOptOutLine ?? 'Reply STOP to opt out.'
  );
  const [previewAs, setPreviewAs] = useState('');
  const [preview, setPreview] = useState<WhatsappTemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [suggesting, setSuggesting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState('DIRECT_RESPONSE');
  const [suggestion, setSuggestion] = useState<WhatsappSuggestion | null>(null);
  const [before, setBefore] = useState<string | null>(null);

  const settled = useDebounced({ body, link, optOut, previewAs });
  useEffect(() => {
    let current = true;
    const linkOk = !settled.link.trim() || isWebLink(settled.link.trim());
    api
      .post<WhatsappTemplatePreview>('/agency/whatsapp/templates/preview', {
        body: settled.body,
        link: linkOk && settled.link.trim() ? settled.link.trim() : undefined,
        optOutLine: settled.optOut,
        contactId: settled.previewAs || undefined,
      })
      .then((result) => {
        if (!current) return;
        setPreview(result);
        setPreviewError(null);
      })
      .catch((err: Error) => {
        if (!current) return;
        setPreview(null);
        setPreviewError(err.message);
      });
    return () => {
      current = false;
    };
  }, [api, settled]);

  const errors = {
    name: name.trim() ? null : 'Give the template a name.',
    body: !body.trim()
      ? 'Write the message.'
      : preview?.problems.length
      ? preview.problems.join(' ')
      : null,
    link:
      link.trim() && !isWebLink(link.trim())
        ? 'Use a full web address starting with https://'
        : null,
  };

  // Wording problems show as soon as the server has seen them; an empty box waits until it was left.
  const bodyError = body.trim()
    ? preview?.problems.join(' ') || undefined
    : touched.show('body', errors.body);

  const insert = (token: string) => {
    const el = document.getElementById(
      'wa-template-body'
    ) as HTMLTextAreaElement | null;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? start;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const suggest = async () => {
    if (!brief.trim() && !body.trim()) {
      toaster.show(
        'Say what the message is about, or write a first version to improve.',
        'warning'
      );
      return;
    }
    setSuggesting(true);
    try {
      const result = await api.post<WhatsappSuggestion>(
        '/agency/whatsapp/templates/suggest',
        {
          brief: brief.trim() || undefined,
          body: body.trim() || undefined,
          tone,
          language: language.trim() || undefined,
        }
      );
      setSuggestion(result);
      if (result.available) {
        setBefore(body);
        setBody(result.text);
      }
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setSuggesting(false);
    }
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['name', 'body', 'link']);
    if (errors.name || errors.body || errors.link) return;
    await run(async () => {
      try {
        const payload = {
          name: name.trim(),
          body: body.trim(),
          language: language.trim(),
          link: link.trim(),
          optOutLine: optOut,
        };
        if (template) {
          await api.put(`/agency/whatsapp/templates/${template.id}`, payload);
        } else {
          await api.post('/agency/whatsapp/templates', payload);
        }
        toaster.show('Template saved.', 'success');
        onSaved();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title={template ? 'Edit template' : 'New template'}
      description="The wording for a message. {{name}} and the other placeholders are filled in for each person."
      size="lg"
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Save template
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-3">
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={touched.blur('name')}
            error={touched.show('name', errors.name)}
            placeholder="Spring welcome"
            maxLength={100}
            autoFocus
          />
          <TextField
            label="Language"
            optional
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en"
            maxLength={12}
          />
        </div>

        <div className="flex flex-col gap-2">
          <TextArea
            id="wa-template-body"
            label="Message"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={touched.blur('body')}
            error={bodyError}
            maxLength={1000}
            placeholder="Hi {{first_name}}, thanks for asking about …"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-textItemBlur mr-1">Add</span>
            {(
              settings?.placeholders ?? [
                'name',
                'first_name',
                'company',
                'agency',
              ]
            ).map((p) => (
              <Btn key={p} variant="ghost" onClick={() => insert(`{{${p}}}`)}>
                {`{{${p}}}`}
              </Btn>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-[color:var(--ag-hairline)] p-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-newTextColor">
              Suggest wording
            </span>
            <Btn onClick={() => setAsking((v) => !v)} aria-expanded={asking}>
              <Icon name="sparkles" size={14} />
              {asking ? 'Hide' : 'Ask the AI'}
            </Btn>
          </div>
          {asking && (
            <div className="flex flex-col gap-3">
              <TextField
                label="What is the message about?"
                optional
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                maxLength={500}
                placeholder="Spring offer for returning customers"
                hint="Leave it empty to improve the wording above. Only this text is sent to the AI, never anyone's details."
              />
              <div className="flex flex-wrap items-end gap-3">
                <SelectField
                  label="Tone"
                  wrapperClassName="w-44"
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                >
                  <option value="DIRECT_RESPONSE">Direct</option>
                  <option value="PROFESSIONAL">Professional</option>
                  <option value="CASUAL">Casual</option>
                  <option value="URGENT">Urgent</option>
                </SelectField>
                <Btn busy={suggesting} onClick={suggest}>
                  Write a suggestion
                </Btn>
              </div>
            </div>
          )}
          {suggestion && 'reason' in suggestion && (
            <Notice
              tone="warn"
              action={
                <Link
                  href="/settings?tab=ai"
                  className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
                >
                  Check AI settings
                </Link>
              }
            >
              The AI could not help right now: {suggestion.reason} Write the
              message yourself; everything else works as usual.
            </Notice>
          )}
          {suggestion && 'text' in suggestion && before !== null && (
            <p className="text-xs text-textItemBlur">
              Suggested by {suggestion.model ?? suggestion.provider}. It is only
              text in the box above: read it, change it, and nothing is sent
              anywhere.{' '}
              <button
                type="button"
                className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
                onClick={() => {
                  setBody(before);
                  setBefore(null);
                }}
              >
                Put back my wording
              </button>
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField
            label="Link"
            optional
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onBlur={touched.blur('link')}
            error={touched.show('link', errors.link)}
            placeholder="https://example.com/offer"
            hint="Added under the message."
          />
          <TextField
            label="Opt-out line"
            value={optOut}
            onChange={(e) => setOptOut(e.target.value)}
            maxLength={200}
            hint="Added to every message made from this template."
          />
        </div>
        {!optOut.trim() && (
          <Notice tone="warn">
            Without an opt-out line, people have no easy way to tell you to
            stop. Keep one such as “Reply STOP to opt out.” unless you have a
            good reason.
          </Notice>
        )}

        <div className="flex flex-col gap-2">
          <SelectField
            label="Preview for"
            value={previewAs}
            onChange={(e) => setPreviewAs(e.target.value)}
          >
            <option value="">A sample person (Alex Example)</option>
            {(people ?? []).slice(0, 100).map((p: WhatsappContactItem) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          {previewError ? (
            <p role="alert" className="text-xs text-[color:var(--ag-bad-fg)]">
              {previewError}
            </p>
          ) : (
            <div
              aria-live="polite"
              className="rounded-2xl rounded-bl-md bg-[var(--ag-neutral-bg)] border border-[color:var(--ag-hairline)] px-4 py-3 text-[13px] leading-relaxed text-newTextColor whitespace-pre-wrap break-words min-h-[3rem]"
            >
              {preview?.message || (
                <span className="text-textItemBlur">
                  The message appears here as you write.
                </span>
              )}
            </div>
          )}
          {preview?.warnings.map((w) => (
            <p key={w} className="text-xs text-[color:var(--ag-warn-fg)]">
              {w}
            </p>
          ))}
        </div>
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Defaults: the opt-out line, and the Business API that is not there yet
// ---------------------------------------------------------------------------
const DefaultsCard: FC = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const canManage = can('whatsapp:manage');
  const { busy, run } = useBusy();
  const settings = useWhatsappSettings();
  const [line, setLine] = useState<string | null>(null);
  const value = line ?? settings.data?.defaultOptOutLine ?? '';
  const problem = value.trim()
    ? null
    : 'The default opt-out line cannot be empty.';

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (problem) return;
    await run(async () => {
      try {
        await api.put('/agency/whatsapp/settings', {
          defaultOptOutLine: value.trim(),
        });
        toaster.show('Saved.', 'success');
        setLine(null);
        void settings.mutate();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Card title="Defaults">
      {settings.error ? (
        <LoadError error={settings.error} onRetry={() => settings.mutate()} />
      ) : !settings.data ? (
        <Loading rows={2} />
      ) : (
        <form onSubmit={save} className="flex flex-col gap-5" noValidate>
          <div className="flex flex-wrap items-end gap-3">
            <TextField
              wrapperClassName="grow min-w-[16rem] max-w-md"
              label="Default opt-out line"
              value={value}
              onChange={(e) => setLine(e.target.value)}
              disabled={!canManage}
              error={line !== null ? problem ?? undefined : undefined}
              maxLength={200}
              hint="New templates and previews start with this line. You can still change it per template."
            />
            {canManage && (
              <Btn
                type="submit"
                variant="primary"
                busy={busy}
                disabled={line === null || !!problem}
              >
                Save
              </Btn>
            )}
          </div>
          <div>
            <CheckField checked={false} disabled readOnly>
              Send through the WhatsApp Business API
            </CheckField>
            <p className="mt-1.5 ml-[26px] text-xs text-textItemBlur">
              {settings.data.businessApi.message}. In this version a person
              sends every message in WhatsApp.
            </p>
          </div>
        </form>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export const TemplatesTab: FC<{ onPrepared: () => void }> = ({
  onPrepared,
}) => {
  const toaster = useToaster();
  const api = useAgencyApi();
  const { can } = useCan();
  const canWrite = can('whatsapp:write');
  const templates = useWhatsappTemplates();
  const segments = useWhatsappSegments();
  const settings = useWhatsappSettings();
  const [editing, setEditing] = useState<WhatsappTemplateView | 'new' | null>(
    null
  );
  const [preparing, setPreparing] = useState<string | null>(null);

  const remove = async (template: WhatsappTemplateView) => {
    if (
      !(await deleteDialog(
        `Delete “${template.name}”? Messages already prepared from it keep their wording.`,
        'Delete template',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.del(`/agency/whatsapp/templates/${template.id}`);
      void templates.mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Templates"
        subtitle="The wording for your messages. Every message made from one ends with its opt-out line."
        right={
          canWrite && (
            <Btn variant="primary" onClick={() => setEditing('new')}>
              New template
            </Btn>
          )
        }
      >
        {templates.error ? (
          <LoadError
            error={templates.error}
            onRetry={() => templates.mutate()}
          />
        ) : !templates.data ? (
          <Loading rows={3} />
        ) : templates.data.length === 0 ? (
          <EmptyState
            icon="doc"
            title="No templates yet"
            hint="A template is the wording of a message, with the person’s name filled in for you."
            action={
              canWrite ? (
                <Btn variant="primary" onClick={() => setEditing('new')}>
                  Write the first template
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-[color:var(--ag-hairline)]">
            {templates.data.map((template) => (
              <li
                key={template.id}
                className="py-4 first:pt-0 last:pb-0 flex flex-wrap items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-newTextColor">
                      {template.name}
                    </span>
                    {template.language && (
                      <span className="text-xs text-textItemBlur">
                        {template.language}
                      </span>
                    )}
                    {template.optOutMissing && (
                      <StatusBadge
                        status="PROPOSAL_SENT"
                        label="No opt-out line"
                      />
                    )}
                  </div>
                  <p className="mt-1 text-[13px] text-textItemBlur whitespace-pre-wrap break-words line-clamp-3">
                    {template.body}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <Btn onClick={() => setPreparing(template.id)}>
                      Prepare messages
                    </Btn>
                    <Menu
                      label={`Actions for ${template.name}`}
                      items={[
                        { label: 'Edit', onClick: () => setEditing(template) },
                        {
                          label: 'Delete',
                          danger: true,
                          onClick: () => void remove(template),
                        },
                      ]}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <DefaultsCard />

      {editing && (
        <TemplateDialog
          template={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void templates.mutate()}
        />
      )}
      {preparing && templates.data && (
        <PrepareDialog
          templates={templates.data}
          segments={segments.data ?? []}
          limit={settings.data?.limits.maxTasksPerDraft ?? 500}
          templateId={preparing}
          onClose={() => setPreparing(null)}
          onDone={onPrepared}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------
const SegmentDialog: FC<{
  segment?: WhatsappSegmentView;
  onClose: () => void;
  onSaved: () => void;
}> = ({ segment, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const { data: facets } = useWhatsappFacets();
  const [name, setName] = useState(segment?.name ?? '');
  const [tags, setTags] = useState<string[]>(segment?.tags ?? []);
  const [languages, setLanguages] = useState<string[]>(
    segment?.languages ?? []
  );
  const [sources, setSources] = useState<string[]>(
    segment?.consentSources ?? []
  );
  const [count, setCount] = useState<number | null>(
    segment?.memberCount ?? null
  );

  const settled = useDebounced({ tags, languages, sources });
  useEffect(() => {
    let current = true;
    api
      .post<{ memberCount: number }>('/agency/whatsapp/segments/preview', {
        tags: settled.tags,
        languages: settled.languages,
        consentSources: settled.sources,
      })
      .then((r) => current && setCount(r.memberCount))
      .catch(() => current && setCount(null));
    return () => {
      current = false;
    };
  }, [api, settled]);

  const errors = { name: name.trim() ? null : 'Give the segment a name.' };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['name']);
    if (errors.name) return;
    await run(async () => {
      try {
        const payload = {
          name: name.trim(),
          tags,
          languages,
          consentSources: sources,
        };
        if (segment) {
          await api.put(`/agency/whatsapp/segments/${segment.id}`, payload);
        } else {
          await api.post('/agency/whatsapp/segments', payload);
        }
        onSaved();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title={segment ? 'Edit segment' : 'New segment'}
      description="A saved filter. Members are counted fresh each time, from the people who are opted in."
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Save segment
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={touched.blur('name')}
          error={touched.show('name', errors.name)}
          placeholder="Berlin customers"
          maxLength={100}
          autoFocus
        />
        <ChipPicker
          label="Tagged with any of"
          options={facets?.tags ?? []}
          value={tags}
          onChange={setTags}
          empty="No tags yet. Add tags to contacts to filter by them."
        />
        <ChipPicker
          label="Language"
          options={facets?.languages ?? []}
          value={languages}
          onChange={setLanguages}
          empty="No languages set on contacts yet."
        />
        <ChipPicker
          label="How they agreed"
          options={facets?.consentSources ?? []}
          value={sources}
          onChange={setSources}
          empty="No contacts yet."
        />
        <p className="text-xs text-textItemBlur">
          People who withdrew consent are never included, whatever the filter
          says. Leave a filter empty to ignore it.
        </p>
        <p
          aria-live="polite"
          className="text-[13px] font-medium text-newTextColor"
        >
          {count === null
            ? 'Counting…'
            : `${count} ${
                count === 1 ? 'person matches' : 'people match'
              } right now`}
        </p>
      </div>
    </Dialog>
  );
};

const describeFilter = (segment: WhatsappSegmentView) => {
  const parts = [
    segment.tags.length ? `tagged ${segment.tags.join(' or ')}` : '',
    segment.languages.length
      ? `language ${segment.languages.join(' or ')}`
      : '',
    segment.consentSources.length
      ? `agreed by ${segment.consentSources.join(' or ')}`
      : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Everyone who is opted in';
};

export const SegmentsTab: FC<{ onPrepared: () => void }> = ({ onPrepared }) => {
  const toaster = useToaster();
  const api = useAgencyApi();
  const { can } = useCan();
  const canWrite = can('whatsapp:write');
  const segments = useWhatsappSegments();
  const templates = useWhatsappTemplates();
  const settings = useWhatsappSettings();
  const [editing, setEditing] = useState<WhatsappSegmentView | 'new' | null>(
    null
  );
  const [preparing, setPreparing] = useState<string | null>(null);

  const remove = async (segment: WhatsappSegmentView) => {
    if (
      !(await deleteDialog(
        `Delete the segment “${segment.name}”? The people in it are not deleted.`,
        'Delete segment',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.del(`/agency/whatsapp/segments/${segment.id}`);
      void segments.mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  return (
    <Card
      title="Segments"
      subtitle="Saved groups of people who are opted in, for preparing messages."
      right={
        canWrite && (
          <Btn variant="primary" onClick={() => setEditing('new')}>
            New segment
          </Btn>
        )
      }
    >
      {segments.error ? (
        <LoadError error={segments.error} onRetry={() => segments.mutate()} />
      ) : !segments.data ? (
        <Loading rows={3} />
      ) : segments.data.length === 0 ? (
        <EmptyState
          icon="users"
          title="No segments yet"
          hint="A segment is a saved filter, such as everyone tagged “berlin”. People who withdrew are never in one."
          action={
            canWrite ? (
              <Btn variant="primary" onClick={() => setEditing('new')}>
                Make the first segment
              </Btn>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-[color:var(--ag-hairline)]">
          {segments.data.map((segment) => (
            <li
              key={segment.id}
              className="py-4 first:pt-0 last:pb-0 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0 flex-1 basis-56">
                <span className="text-[13px] font-semibold text-newTextColor">
                  {segment.name}
                </span>
                <p className="mt-0.5 text-xs text-textItemBlur">
                  {describeFilter(segment)}
                </p>
              </div>
              <span className="text-[13px] tabular-nums text-newTextColor">
                {segment.memberCount}{' '}
                <span className="text-textItemBlur">
                  {segment.memberCount === 1 ? 'person' : 'people'}
                </span>
              </span>
              {canWrite && (
                <div className="flex items-center gap-2">
                  <Btn
                    disabled={segment.memberCount === 0}
                    onClick={() => setPreparing(segment.id)}
                  >
                    Prepare messages
                  </Btn>
                  <Menu
                    label={`Actions for ${segment.name}`}
                    items={[
                      { label: 'Edit', onClick: () => setEditing(segment) },
                      {
                        label: 'Delete',
                        danger: true,
                        onClick: () => void remove(segment),
                      },
                    ]}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <SegmentDialog
          segment={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void segments.mutate()}
        />
      )}
      {preparing && (
        <PrepareDialog
          templates={templates.data ?? []}
          segments={segments.data ?? []}
          limit={settings.data?.limits.maxTasksPerDraft ?? 500}
          segmentId={preparing}
          onClose={() => setPreparing(null)}
          onDone={onPrepared}
        />
      )}
    </Card>
  );
};
