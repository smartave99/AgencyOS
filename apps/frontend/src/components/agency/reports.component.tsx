'use client';

import React, { FC, useMemo, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  PublishingReport,
  useClients,
  usePublishingReport,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  EmptyState,
  formatDate,
  Icon,
  LoadError,
  Loading,
  PageHeader,
  PageShell,
  Segmented,
  SelectField,
  Stat,
  TextField,
  TONE_TEXT,
  tableClass,
} from '@gitroom/frontend/components/agency/agency.ui';

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

const presetRange = (days: number) => {
  const now = new Date();
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return { from: iso(new Date(to.getTime() - (days - 1) * DAY)), to: iso(to) };
};

const PRESETS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom' },
];

const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);

// ---------------------------------------------------------------------------
// CSV: numbers straight from the report; formulas in names are neutralised
// ---------------------------------------------------------------------------
const cell = (value: string | number | null) => {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const toCsv = (report: PublishingReport) => {
  const rows: Array<Array<string | number | null>> = [
    [
      'Campaign',
      'Client',
      'Delivered',
      'Failed',
      'Paused',
      'Queued',
      'Needs check',
      'Delivery rate %',
      'Tracked clicks',
      'Last delivered',
    ],
    ...report.campaigns.map((c) => [
      c.name,
      c.client,
      c.delivered,
      c.failed,
      c.paused,
      c.queued,
      c.uncertain,
      c.deliveryRate,
      c.trackedClicks,
      c.lastDeliveredAt,
    ]),
  ];
  // Versions of an ad go in their own block, so the campaign rows above stay one row per campaign.
  if (report.variants.length) {
    rows.push(
      [],
      [
        'Campaign',
        'Version',
        'Delivered',
        'Failed',
        'Paused',
        'Queued',
        'Needs check',
        'Delivery rate %',
      ],
      ...report.variants.map((v) => [
        v.campaignName,
        v.label,
        v.delivered,
        v.failed,
        v.paused,
        v.queued,
        v.uncertain,
        v.deliveryRate,
      ])
    );
  }
  return rows.map((r) => r.map(cell).join(',')).join('\n');
};

// ---------------------------------------------------------------------------
// Daily chart: plain SVG, one stacked bar per day
// ---------------------------------------------------------------------------
const DailyChart: FC<{ days: PublishingReport['daily'] }> = ({ days }) => {
  const max = Math.max(1, ...days.map((d) => d.delivered + d.failed + d.other));
  const W = 1000;
  const H = 120;
  const gap = days.length > 45 ? 1 : 3;
  const bar = (W - gap * (days.length - 1)) / days.length;
  const total = days.reduce((n, d) => n + d.delivered + d.failed + d.other, 0);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H + 18}`}
        role="img"
        aria-label={`Posts due per day, ${days.length} days, ${total} in total`}
        className="w-full h-auto"
      >
        <line
          x1="0"
          x2={W}
          y1={H}
          y2={H}
          stroke="var(--ag-hairline)"
          strokeWidth="1"
        />
        {days.map((d, i) => {
          const x = i * (bar + gap);
          const delivered = (d.delivered / max) * H;
          const failed = (d.failed / max) * H;
          const other = (d.other / max) * H;
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${d.delivered} delivered, ${d.failed} failed, ${d.other} other`}</title>
              <rect
                x={x}
                y={H - delivered}
                width={bar}
                height={delivered}
                rx={Math.min(3, bar / 2)}
                fill="var(--ag-good-fg)"
              />
              <rect
                x={x}
                y={H - delivered - failed}
                width={bar}
                height={failed}
                fill="var(--ag-bad-fg)"
              />
              <rect
                x={x}
                y={H - delivered - failed - other}
                width={bar}
                height={other}
                fill="var(--ag-neutral-fg)"
                opacity="0.55"
              />
            </g>
          );
        })}
        <text x="0" y={H + 14} fontSize="11" fill="var(--new-textItemBlur)">
          {days[0]?.date}
        </text>
        <text
          x={W}
          y={H + 14}
          fontSize="11"
          textAnchor="end"
          fill="var(--new-textItemBlur)"
        >
          {days[days.length - 1]?.date}
        </text>
        <text
          x={W}
          y="11"
          fontSize="11"
          textAnchor="end"
          fill="var(--new-textItemBlur)"
        >
          {max} / day at most
        </text>
      </svg>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-textItemBlur">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[var(--ag-good-fg)]" />{' '}
          Delivered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[var(--ag-bad-fg)]" /> Failed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[var(--ag-neutral-fg)] opacity-60" />{' '}
          Queued, paused or needs check
        </span>
      </div>
    </div>
  );
};

export const AgencyReportsComponent = () => {
  const toaster = useToaster();
  const clients = useClients();
  const [preset, setPreset] = useState('30');
  const [custom, setCustom] = useState(presetRange(30));
  const [customerId, setCustomerId] = useState('');

  const range = useMemo(
    () => (preset === 'custom' ? custom : presetRange(Number(preset))),
    [preset, custom]
  );
  const validRange = range.from <= range.to;
  const { data, error, mutate } = usePublishingReport(
    validRange ? range.from : presetRange(30).from,
    validRange ? range.to : presetRange(30).to,
    customerId
  );

  const clientName = customerId
    ? (clients.data ?? []).find((c) => c.id === customerId)
    : null;

  const download = () => {
    if (!data) return;
    const blob = new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `publishing-report-${data.range.from}-to-${data.range.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toaster.show('Report downloaded', 'success');
  };

  return (
    <PageShell>
      <div className="ag-no-print">
        <PageHeader
          title="Reports"
          subtitle="What was due, what Telegram confirmed and what failed, counted from stored send results."
          actions={
            <>
              <Btn
                onClick={download}
                disabled={!data || data.campaigns.length === 0}
              >
                Export CSV
              </Btn>
              <Btn
                variant="primary"
                onClick={() => window.print()}
                disabled={!data}
              >
                <Icon name="doc" size={15} />
                Print or save as PDF
              </Btn>
            </>
          }
        />
      </div>

      <div className="ag-no-print flex flex-wrap items-end gap-4">
        <Segmented
          ariaLabel="Period"
          value={preset}
          onChange={setPreset}
          options={PRESETS}
        />
        {preset === 'custom' && (
          <>
            <TextField
              label="From"
              type="date"
              wrapperClassName="w-40"
              value={custom.from}
              max={custom.to}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
            <TextField
              label="To"
              type="date"
              wrapperClassName="w-40"
              value={custom.to}
              min={custom.from}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </>
        )}
        <SelectField
          label="Client"
          wrapperClassName="w-56"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          <option value="">All clients</option>
          {(clients.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.companyName || c.name}
            </option>
          ))}
        </SelectField>
      </div>
      {!validRange && (
        <p role="alert" className={`text-[13px] ${TONE_TEXT.bad}`}>
          The start date must not be after the end date.
        </p>
      )}

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading report" />
      ) : (
        <div className="ag-print-area flex flex-col gap-6">
          <div className="ag-print-only">
            <h1 className="text-2xl font-semibold">Publishing report</h1>
            <p className="text-sm">
              {clientName
                ? `${clientName.companyName || clientName.name} · `
                : ''}
              {formatDate(`${data.range.from}T12:00:00Z`)} to{' '}
              {formatDate(`${data.range.to}T12:00:00Z`)} (UTC)
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat
              label="Delivered"
              value={data.totals.delivered}
              tone="good"
              hint="Confirmed by Telegram"
            />
            <Stat
              label="Failed"
              value={data.totals.failed}
              tone={data.totals.failed ? 'bad' : undefined}
              hint="Retries used up or refused"
            />
            <Stat
              label="Delivery rate"
              value={pct(data.totals.deliveryRate)}
              hint={
                data.totals.deliveryRate === null
                  ? 'Nothing resolved in this period'
                  : 'Delivered of delivered + failed'
              }
            />
            <Stat
              label="Tracked link clicks"
              value={data.totals.trackedClicks.toLocaleString()}
              hint="Real visits, preview bots excluded"
            />
          </div>

          {data.campaigns.length === 0 ? (
            <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
              <EmptyState
                icon="chart"
                title="No posts were due in this period"
                hint="Pick a longer period, or schedule a campaign. Nothing is estimated for days with no activity."
              />
            </div>
          ) : (
            <>
              <Card
                title="Posts per day"
                subtitle={`Counted on the day each post was due (${data.range.timezone}).`}
              >
                <DailyChart days={data.daily} />
                {data.dailyTruncated && (
                  <p className={`text-xs ${TONE_TEXT.warn}`}>
                    This period has more posts than the chart reads; the totals
                    above are still exact.
                  </p>
                )}
              </Card>

              <Card title="By campaign">
                <div className={tableClass.wrap}>
                  <table className={tableClass.table}>
                    <thead className={tableClass.head}>
                      <tr>
                        <th className={tableClass.th}>Campaign</th>
                        <th className={tableClass.th}>Client</th>
                        <th className={`${tableClass.th} text-right`}>
                          Delivered
                        </th>
                        <th className={`${tableClass.th} text-right`}>
                          Failed
                        </th>
                        <th className={`${tableClass.th} text-right`}>Open</th>
                        <th className={`${tableClass.th} text-right`}>Rate</th>
                        <th className={`${tableClass.th} text-right`}>
                          Clicks
                        </th>
                        <th className={tableClass.th}>Last delivered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.campaigns.map((c) => (
                        <tr key={c.id} className={tableClass.row}>
                          <td
                            className={`${tableClass.td} font-medium text-newTextColor`}
                          >
                            {c.name}
                          </td>
                          <td className={`${tableClass.td} text-textItemBlur`}>
                            {c.client}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums`}
                          >
                            {c.delivered}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums`}
                          >
                            {c.failed}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                            title="Queued, paused or needing a check"
                          >
                            {c.queued + c.paused + c.uncertain}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums`}
                          >
                            {pct(c.deliveryRate)}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums`}
                          >
                            {c.trackedClicks}
                          </td>
                          <td className={`${tableClass.td} text-textItemBlur`}>
                            {c.lastDeliveredAt
                              ? formatDate(c.lastDeliveredAt)
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="By destination">
                <div className={tableClass.wrap}>
                  <table className={tableClass.table}>
                    <thead className={tableClass.head}>
                      <tr>
                        <th className={tableClass.th}>Destination</th>
                        <th className={`${tableClass.th} text-right`}>
                          Delivered
                        </th>
                        <th className={`${tableClass.th} text-right`}>
                          Failed
                        </th>
                        <th className={`${tableClass.th} text-right`}>Open</th>
                        <th className={`${tableClass.th} text-right`}>Rate</th>
                        <th className={tableClass.th}>Last delivered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.destinations.map((d) => (
                        <tr key={d.id} className={tableClass.row}>
                          <td
                            className={`${tableClass.td} font-medium text-newTextColor`}
                          >
                            {d.title}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums`}
                          >
                            {d.delivered}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums`}
                          >
                            {d.failed}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                          >
                            {d.queued + d.paused + d.uncertain}
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums`}
                          >
                            {pct(d.deliveryRate)}
                          </td>
                          <td className={`${tableClass.td} text-textItemBlur`}>
                            {d.lastDeliveredAt
                              ? formatDate(d.lastDeliveredAt)
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {data.variants.length > 0 && (
                <Card
                  title="Versions of an ad"
                  subtitle="Only campaigns that posted more than one version in this period. Delivery, not response: clicks are counted per campaign."
                >
                  <div className={tableClass.wrap}>
                    <table className={tableClass.table}>
                      <thead className={tableClass.head}>
                        <tr>
                          <th className={tableClass.th}>Campaign</th>
                          <th className={tableClass.th}>Version</th>
                          <th className={`${tableClass.th} text-right`}>
                            Delivered
                          </th>
                          <th className={`${tableClass.th} text-right`}>
                            Failed
                          </th>
                          <th className={`${tableClass.th} text-right`}>
                            Open
                          </th>
                          <th className={`${tableClass.th} text-right`}>
                            Rate
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.variants.map((v) => (
                          <tr
                            key={`${v.campaignId}-${v.label}`}
                            className={tableClass.row}
                          >
                            <td
                              className={`${tableClass.td} font-medium text-newTextColor`}
                            >
                              {v.campaignName}
                            </td>
                            <td className={tableClass.td}>{v.label}</td>
                            <td
                              className={`${tableClass.td} text-right tabular-nums`}
                            >
                              {v.delivered}
                            </td>
                            <td
                              className={`${tableClass.td} text-right tabular-nums`}
                            >
                              {v.failed}
                            </td>
                            <td
                              className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                            >
                              {v.queued + v.paused + v.uncertain}
                            </td>
                            <td
                              className={`${tableClass.td} text-right tabular-nums`}
                            >
                              {pct(v.deliveryRate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}

          <section aria-label="How these numbers are counted">
            <h2 className="text-[13px] font-semibold text-newTextColor mb-2">
              How these numbers are counted
            </h2>
            <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-textItemBlur list-disc pl-4">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </PageShell>
  );
};
