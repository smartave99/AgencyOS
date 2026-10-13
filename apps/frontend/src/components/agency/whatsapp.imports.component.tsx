'use client';

import React, { FC, useRef, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  useAgencyApi,
  useCan,
  useWhatsappImports,
  useWhatsappSettings,
  WhatsappImportPreview,
  WhatsappImportRowStatus,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  CheckField,
  EmptyState,
  formatDateTime,
  LoadError,
  Loading,
  Notice,
  StatusBadge,
  tableClass,
  TextArea,
  useBusy,
} from '@gitroom/frontend/components/agency/agency.ui';
import {
  refreshWhatsapp,
  useCopy,
} from '@gitroom/frontend/components/agency/whatsapp.shared';

const EXAMPLE_CSV = [
  'name,phone,consent_source,consent_date,language,tags,company,consent_evidence',
  'Alex Example,+4915112345678,Web form,2026-03-14,en,vip|berlin,Example Ltd,Ticked the box on the spring-offer page',
].join('\n');

// The API accepts a JSON body of up to 100 KB, so the file is checked here before it is sent.
const MAX_BODY_BYTES = 100000;
const MAX_FILE_BYTES = 500000;

const ROW_BADGE: Record<
  WhatsappImportRowStatus,
  { tone: string; label: string }
> = {
  VALID: { tone: 'ACTIVE', label: 'Ready' },
  DUPLICATE: { tone: 'SKIPPED', label: 'Duplicate' },
  INVALID: { tone: 'DEAD', label: 'Invalid' },
  MISSING_CONSENT: { tone: 'PROPOSAL_SENT', label: 'No consent' },
  WITHDRAWN: { tone: 'REVOKED', label: 'Withdrew' },
};

const SHOWN_ROWS = 200;

const Count: FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-xl border border-[color:var(--ag-hairline)] px-4 py-3">
    <span className="block text-xs text-textItemBlur">{label}</span>
    <span className="block text-xl font-semibold tabular-nums text-newTextColor">
      {value}
    </span>
  </div>
);

export const ImportsTab: FC = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const copy = useCopy();
  const { can } = useCan();
  const canWrite = can('whatsapp:write');
  const settings = useWhatsappSettings();
  const imports = useWhatsappImports();
  const picker = useRef<HTMLInputElement>(null);
  const checking = useBusy();
  const committing = useBusy();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<WhatsappImportPreview | null>(null);
  const [attested, setAttested] = useState(false);
  const [attestError, setAttestError] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const limits = settings.data?.limits;
  const lines = csv.split(/\r?\n/).filter((l) => l.trim()).length;
  const bytes = new TextEncoder().encode(
    JSON.stringify({ csv, attested: true, fileName })
  ).length;
  const sizeProblem = !csv.trim()
    ? null
    : lines - 1 > (limits?.maxImportRows ?? 2000)
    ? `This file has ${lines - 1} rows. Import at most ${
        limits?.maxImportRows ?? 2000
      } at a time.`
    : csv.length > (limits?.maxImportChars ?? 90000) || bytes > MAX_BODY_BYTES
    ? 'This file is too big to send in one go (about 90 KB). Split it into parts and import them one after the other.'
    : null;

  const edit = (text: string, name = '') => {
    setCsv(text);
    setFileName(name);
    setPreview(null);
    setAttested(false);
    setAttestError(false);
    setShowAll(false);
    setDone(null);
  };

  const choose = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toaster.show(
        'That file is too big to import in one go. Split it into parts.',
        'warning'
      );
      return;
    }
    edit(await file.text(), file.name);
  };

  const check = async () => {
    if (!csv.trim() || sizeProblem) return;
    await checking.run(async () => {
      try {
        setPreview(
          await api.post<WhatsappImportPreview>(
            '/agency/whatsapp/imports/preview',
            { csv }
          )
        );
        setAttested(false);
        setDone(null);
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const commit = async () => {
    if (!preview) return;
    if (!attested) {
      setAttestError(true);
      return;
    }
    await committing.run(async () => {
      try {
        const result = await api.post<{
          importedRows: number;
          totalRows: number;
        }>('/agency/whatsapp/imports', {
          csv,
          attested: true,
          fileName: fileName || undefined,
        });
        toaster.show(
          `${result.importedRows} of ${result.totalRows} rows imported.`,
          'success'
        );
        setDone(
          `${result.importedRows} of ${result.totalRows} rows were imported. The others were left out and nothing was changed for them.`
        );
        setCsv('');
        setFileName('');
        setPreview(null);
        setAttested(false);
        void refreshWhatsapp();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const rows = preview
    ? [...preview.rows].sort(
        (a, b) =>
          Number(a.status === 'VALID') - Number(b.status === 'VALID') ||
          a.line - b.line
      )
    : [];
  const visible = showAll ? rows : rows.slice(0, SHOWN_ROWS);

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Import people"
        subtitle="Bring in a list of people who agreed to be contacted on WhatsApp. Each row must say how and when that person agreed."
      >
        {!canWrite ? (
          <Notice>Your role can see imports but not make them.</Notice>
        ) : (
          <>
            <div className="text-[13px] text-textItemBlur leading-relaxed">
              <p>
                <span className="text-newTextColor font-medium">
                  Needed in every row:
                </span>{' '}
                <code>name</code>, <code>phone</code> (with the country code,
                like +4915112345678), <code>consent_source</code> and{' '}
                <code>consent_date</code> (YYYY-MM-DD).
              </p>
              <p className="mt-1">
                <span className="text-newTextColor font-medium">Optional:</span>{' '}
                <code>language</code>, <code>tags</code> (separate with |),{' '}
                <code>company</code>, <code>notes</code>,{' '}
                <code>consent_evidence</code>. Rows without a consent source and
                date are never imported.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={picker}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="sr-only"
                tabIndex={-1}
                aria-label="Choose a CSV file"
                onChange={choose}
              />
              <Btn onClick={() => picker.current?.click()}>
                Choose a CSV file
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => void copy(EXAMPLE_CSV, 'Example copied.')}
              >
                Copy an example
              </Btn>
              {fileName && (
                <span className="text-xs text-textItemBlur">{fileName}</span>
              )}
            </div>
            <TextArea
              label="Or paste the CSV here"
              rows={6}
              value={csv}
              onChange={(e) => edit(e.target.value)}
              error={sizeProblem ?? undefined}
              className="font-mono text-xs"
              placeholder={EXAMPLE_CSV}
              spellCheck={false}
            />
            <div>
              <Btn
                variant="primary"
                busy={checking.busy}
                disabled={!csv.trim() || !!sizeProblem}
                onClick={check}
              >
                Check the file
              </Btn>
              <span className="ml-3 text-xs text-textItemBlur">
                Checking only reads it: nothing is saved yet.
              </span>
            </div>
          </>
        )}

        {done && <Notice tone="good">{done}</Notice>}

        {preview && (
          <div className="flex flex-col gap-5">
            {preview.columnProblems.length > 0 && (
              <Notice tone="warn">
                <ul className="list-disc pl-4">
                  {preview.columnProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <Count label="Ready to import" value={preview.counts.valid} />
              <Count
                label="Already contacts"
                value={preview.counts.duplicate}
              />
              <Count label="Invalid" value={preview.counts.invalid} />
              <Count label="No consent" value={preview.counts.missingConsent} />
              <Count label="Withdrew before" value={preview.counts.withdrawn} />
            </div>

            <div className={tableClass.wrap}>
              <table className={tableClass.table}>
                <thead className={tableClass.head}>
                  <tr>
                    <th className={tableClass.th}>Line</th>
                    <th className={tableClass.th}>Person</th>
                    <th className={tableClass.th}>Result</th>
                    <th className={tableClass.th}>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.line} className={tableClass.row}>
                      <td
                        className={`${tableClass.td} tabular-nums text-textItemBlur`}
                      >
                        {row.line}
                      </td>
                      <td className={tableClass.td}>
                        {row.name || '—'}
                        {row.phone && (
                          <span className="block text-xs text-textItemBlur tabular-nums">
                            {row.phone}
                          </span>
                        )}
                      </td>
                      <td className={tableClass.td}>
                        <StatusBadge
                          status={ROW_BADGE[row.status].tone}
                          label={ROW_BADGE[row.status].label}
                        />
                      </td>
                      <td className={`${tableClass.td} text-textItemBlur`}>
                        {row.reasons.join(' ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > SHOWN_ROWS && (
              <div>
                <Btn variant="ghost" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer rows' : `Show all ${rows.length} rows`}
                </Btn>
              </div>
            )}

            {canWrite && (
              <div className="rounded-xl border border-[color:var(--ag-hairline)] p-4 flex flex-col gap-4">
                <CheckField
                  checked={attested}
                  onChange={(e) => {
                    setAttested(e.target.checked);
                    setAttestError(false);
                  }}
                  error={
                    attestError ? 'Confirm this before importing.' : undefined
                  }
                >
                  {settings.data?.attestation ??
                    'I confirm that the people in this file agreed to be contacted on WhatsApp, and that the consent source and date on each row are true.'}
                </CheckField>
                <div>
                  <Btn
                    variant="primary"
                    busy={committing.busy}
                    disabled={!preview.canImport}
                    onClick={commit}
                  >
                    {`Import ${preview.counts.valid} ${
                      preview.counts.valid === 1 ? 'person' : 'people'
                    }`}
                  </Btn>
                  {!preview.canImport && (
                    <span className="ml-3 text-xs text-textItemBlur">
                      Nobody in this file can be imported yet.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Past imports"
        subtitle="Each import keeps the confirmation of the person who made it."
      >
        {imports.error ? (
          <LoadError error={imports.error} onRetry={() => imports.mutate()} />
        ) : !imports.data ? (
          <Loading rows={2} />
        ) : imports.data.length === 0 ? (
          <EmptyState
            icon="doc"
            title="No imports yet"
            hint="Lists you import appear here with who confirmed them and what was left out."
          />
        ) : (
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>When</th>
                  <th className={tableClass.th}>File</th>
                  <th className={tableClass.th}>Confirmed by</th>
                  <th className={tableClass.th}>Imported</th>
                  <th className={tableClass.th}>Left out</th>
                </tr>
              </thead>
              <tbody>
                {imports.data.map((batch) => (
                  <tr key={batch.id} className={tableClass.row}>
                    <td
                      className={`${tableClass.td} text-textItemBlur whitespace-nowrap`}
                    >
                      {formatDateTime(batch.createdAt)}
                    </td>
                    <td className={tableClass.td}>
                      {batch.fileName ?? 'Pasted text'}
                    </td>
                    <td className={tableClass.td}>{batch.attestedBy}</td>
                    <td className={`${tableClass.td} tabular-nums`}>
                      {batch.importedRows} of {batch.totalRows}
                    </td>
                    <td
                      className={`${tableClass.td} text-xs text-textItemBlur`}
                    >
                      {[
                        batch.duplicateRows
                          ? `${batch.duplicateRows} duplicate`
                          : '',
                        batch.invalidRows ? `${batch.invalidRows} invalid` : '',
                        batch.missingConsentRows
                          ? `${batch.missingConsentRows} without consent`
                          : '',
                        batch.withdrawnRows
                          ? `${batch.withdrawnRows} withdrew before`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};
