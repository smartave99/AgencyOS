'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  AdTemplate,
  useAdTemplates,
  useAgencyApi,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Dialog,
  EmptyState,
  Loading,
  TextField,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

/** The ad as the composer holds it. */
export interface AdContent {
  contentTitle: string;
  contentBody: string;
  contentMedia: string;
  ctaLink: string;
  ctaText: string;
}

/**
 * Saved ad formats. Using one only fills the composer: nothing is chosen for the person and nothing
 * is sent, so the campaign is reviewed like any other. Saving stores the ad text, media and link only.
 */
export const TemplatesDialog: FC<{
  current: AdContent;
  onUse: (template: AdTemplate) => void;
  onClose: () => void;
}> = ({ current, onUse, onClose }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { data, mutate, error } = useAdTemplates();
  const [name, setName] = useState('');
  const touched = useTouched();
  const { busy, run } = useBusy();
  const canSave = !!current.contentBody.trim();
  const nameError = name.trim() ? null : 'Give the template a name.';

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['name']);
    if (nameError || !canSave) return;
    await run(async () => {
      try {
        await api.post('/agency/templates', {
          name: name.trim(),
          contentTitle: current.contentTitle.trim(),
          contentBody: current.contentBody.trim(),
          contentMedia: current.contentMedia,
          ctaLink: current.ctaLink.trim(),
          ctaText: current.ctaText.trim(),
        });
        setName('');
        touched.reset();
        toaster.show('Template saved.', 'success');
        await mutate();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const remove = async (template: AdTemplate) => {
    if (
      !(await deleteDialog(
        `Delete the template “${template.name}”? Campaigns already made from it are not changed.`,
        'Delete template',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.del(`/agency/templates/${template.id}`);
      toaster.show('Template deleted.', 'success');
      await mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  return (
    <Dialog
      title="Ad templates"
      description="Start from a saved ad, or save this one to use again. A template holds the text, media and link only."
      size="lg"
      onClose={onClose}
      busy={busy}
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-3">
            <TextField
              label="Save this ad as a template"
              wrapperClassName="flex-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={touched.blur('name')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
              error={touched.show('name', nameError)}
              placeholder="Weekly offer"
              disabled={!canSave}
            />
            <Btn
              variant="primary"
              busy={busy}
              disabled={!canSave}
              onClick={() => void save()}
            >
              Save template
            </Btn>
          </div>
          {!canSave && (
            <p className="text-xs text-textItemBlur">
              Write the ad text first, then it can be saved.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-newTextColor">
            Saved templates
          </p>
          {error ? (
            <p className="text-[13px] text-[color:var(--ag-bad-text)]">
              The templates could not be loaded.
            </p>
          ) : !data ? (
            <Loading rows={2} />
          ) : data.length === 0 ? (
            <EmptyState
              icon="inbox"
              title="No templates yet"
              hint="Write an ad you will use again, then save it here."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-[color:var(--ag-hairline)] rounded-xl border border-[color:var(--ag-hairline)]">
              {data.map((template) => (
                <li
                  key={template.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-newTextColor">
                      {template.name}
                    </p>
                    <p className="truncate text-xs text-textItemBlur">
                      {template.contentTitle || template.contentBody}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Btn
                      onClick={() => {
                        onUse(template);
                        onClose();
                      }}
                    >
                      Use
                    </Btn>
                    <Btn variant="danger" onClick={() => void remove(template)}>
                      Delete
                    </Btn>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
};
