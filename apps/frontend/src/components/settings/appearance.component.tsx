'use client';

import React, { FC } from 'react';
import clsx from 'clsx';
import {
  ThemePreference,
  useTheme,
} from '@gitroom/frontend/components/layout/theme';
import { Card, Icon } from '@gitroom/frontend/components/agency/agency.ui';

const Preview: FC<{ mode: 'light' | 'dark' }> = ({ mode }) => {
  const dark = mode === 'dark';
  return (
    <div
      aria-hidden="true"
      className={clsx(
        'flex h-[84px] overflow-hidden rounded-lg border',
        dark ? 'border-white/10 bg-[#121212]' : 'border-black/10 bg-[#f4f4f7]'
      )}
    >
      <div className={clsx('w-[26%] p-2', dark ? 'bg-[#1a1919]' : 'bg-white')}>
        <div className="mb-1.5 h-1.5 w-4 rounded-full bg-[#7c4dff]" />
        <div
          className={clsx(
            'mb-1 h-1 rounded-full',
            dark ? 'bg-white/20' : 'bg-black/15'
          )}
        />
        <div
          className={clsx(
            'h-1 w-3/4 rounded-full',
            dark ? 'bg-white/10' : 'bg-black/10'
          )}
        />
      </div>
      <div className="flex-1 p-2">
        <div
          className={clsx(
            'mb-1.5 h-1.5 w-1/3 rounded-full',
            dark ? 'bg-white/30' : 'bg-black/25'
          )}
        />
        <div
          className={clsx('h-9 rounded-md', dark ? 'bg-[#1a1919]' : 'bg-white')}
        />
      </div>
    </div>
  );
};

const CHOICES: Array<{
  id: ThemePreference;
  label: string;
  hint: string;
}> = [
  { id: 'light', label: 'Light', hint: 'Bright and clean.' },
  { id: 'dark', label: 'Dark', hint: 'Easier on the eyes at night.' },
  { id: 'system', label: 'System', hint: 'Follow this computer’s setting.' },
];

export const AppearanceComponent: FC = () => {
  const { preference, setPreference } = useTheme();
  return (
    <div className="ag-scope flex flex-col gap-6">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight">Appearance</h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-textItemBlur">
          Pick how AgencyOS looks. The sun and moon button in the top bar is a
          quick way to switch.
        </p>
      </div>
      <Card title="Theme">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid gap-3 sm:grid-cols-3"
        >
          {CHOICES.map((choice) => {
            const selected = preference === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setPreference(choice.id)}
                className={clsx(
                  'flex flex-col gap-3 rounded-2xl border p-3 text-start transition-colors',
                  selected
                    ? 'border-[color:var(--ag-accent)] bg-[var(--ag-accent-soft)]'
                    : 'border-[color:var(--ag-hairline)] hover:border-[color:var(--ag-neutral-line)] hover:bg-boxHover'
                )}
              >
                {choice.id === 'system' ? (
                  <div className="grid grid-cols-2 gap-1">
                    <Preview mode="light" />
                    <Preview mode="dark" />
                  </div>
                ) : (
                  <Preview mode={choice.id} />
                )}
                <span className="flex items-center gap-2">
                  <Icon
                    name={
                      choice.id === 'light'
                        ? 'sun'
                        : choice.id === 'dark'
                        ? 'moon'
                        : 'monitor'
                    }
                    size={15}
                    className={
                      selected
                        ? 'text-[color:var(--ag-accent-text)]'
                        : 'text-textItemBlur'
                    }
                  />
                  <span className="text-[13px] font-semibold">
                    {choice.label}
                  </span>
                  {selected && (
                    <Icon
                      name="tick"
                      size={14}
                      className="ms-auto text-[color:var(--ag-accent-text)]"
                    />
                  )}
                </span>
                <span className="-mt-2 text-[12px] text-textItemBlur">
                  {choice.hint}
                </span>
              </button>
            );
          })}
        </div>
      </Card>
    </div>
  );
};
