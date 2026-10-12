'use client';

import { FC, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import i18next from 'i18next';
import { useClickAway } from '@uidotdev/usehooks';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { ChangeLanguageComponent } from '@gitroom/frontend/components/layout/language.component';
import { LogoutComponent } from '@gitroom/frontend/components/layout/logout.component';
import {
  ThemePreference,
  useTheme,
} from '@gitroom/frontend/components/layout/theme';
import {
  Icon,
  IconName,
} from '@gitroom/frontend/components/agency/agency.icons';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

const THEMES: Array<{ id: ThemePreference; label: string; icon: IconName }> = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'System', icon: 'monitor' },
];

const initialsOf = (name?: string | null, email?: string | null) => {
  const source = (name || email || 'A').trim();
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  return (
    (words[0]?.[0] ?? 'A') + (words.length > 1 ? (words[1]?.[0] ?? '') : '')
  ).toUpperCase();
};

/** Light, dark or follow the computer. Used in the account menu and in Settings. */
export const ThemeSegmented: FC = () => {
  const t = useT();
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label={t('theme', 'Theme')}
      className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--ag-neutral-bg)] p-1"
    >
      {THEMES.map((theme) => (
        <button
          key={theme.id}
          type="button"
          role="radio"
          aria-checked={preference === theme.id}
          onClick={() => setPreference(theme.id)}
          className={clsx(
            'flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium transition-colors',
            preference === theme.id
              ? 'bg-newBgColorInner text-newTextColor shadow-[var(--ag-shadow)]'
              : 'text-textItemBlur hover:text-newTextColor'
          )}
        >
          <Icon name={theme.icon} size={14} />
          {t(`theme_${theme.id}`, theme.label)}
        </button>
      ))}
    </div>
  );
};

const Row: FC<{
  icon: IconName;
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  trailing?: ReactNode;
}> = ({ icon, children, href, onClick, trailing }) => {
  const className =
    'flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[13px] text-newTextColor hover:bg-boxHover';
  const body = (
    <>
      <Icon name={icon} size={16} className="text-textItemBlur" />
      <span className="flex-1 truncate text-start">{children}</span>
      {trailing}
    </>
  );
  return href ? (
    <Link href={href} className={className} onClick={onClick}>
      {body}
    </Link>
  ) : (
    <button type="button" className={className} onClick={onClick}>
      {body}
    </button>
  );
};

/** Who is signed in, plus the personal things: theme, language, guide and sign out. */
export const AccountMenu: FC = () => {
  const t = useT();
  const user = useUser();
  const modals = useModals();
  const { isLocal } = useVariables();
  const [open, setOpen] = useState(false);
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const initials = useMemo(
    () => initialsOf(user?.name, user?.email),
    [user?.name, user?.email]
  );
  const close = useCallback(() => setOpen(false), []);
  const language = (i18next.resolvedLanguage || 'en').toUpperCase();
  const openLanguage = () => {
    close();
    modals.openModal({
      title: t('change_language', 'Change Language'),
      withCloseButton: true,
      children: <ChangeLanguageComponent />,
    });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('account_menu', 'Account menu')}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ag-accent-soft)] text-[12px] font-semibold text-[color:var(--ag-accent-text)] hover:ring-2 hover:ring-[color:var(--ag-accent-soft)]"
      >
        {initials}
      </button>
      {open && (
        <div
          role="menu"
          className="ag-scope ag-pop absolute end-0 top-[calc(100%+8px)] z-[600] w-[288px] rounded-2xl border border-[color:var(--ag-hairline)] bg-newBgColorInner p-2 text-newTextColor shadow-[var(--ag-shadow-pop)]"
        >
          <div className="flex items-center gap-3 px-2.5 py-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--ag-accent-soft)] text-[13px] font-semibold text-[color:var(--ag-accent-text)]">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold">
                {user?.name || t('your_workspace', 'Your workspace')}
              </div>
              <div className="truncate text-[12px] text-textItemBlur">
                {isLocal
                  ? t('runs_on_this_computer', 'Running on this computer')
                  : user?.email}
              </div>
            </div>
          </div>
          <div className="px-1 pb-2 pt-1">
            <ThemeSegmented />
          </div>
          <div className="my-1 h-px bg-[color:var(--ag-hairline)]" />
          <Row icon="sliders" href="/settings" onClick={close}>
            {t('settings', 'Settings')}
          </Row>
          <Row icon="help" href="/guide" onClick={close}>
            {t('guide', 'Guide')}
          </Row>
          <Row icon="flag" href="/guide/changelog" onClick={close}>
            {t('whats_new', 'What’s new')}
          </Row>
          <Row
            icon="globe"
            onClick={openLanguage}
            trailing={
              <span className="text-[11px] text-textItemBlur">{language}</span>
            }
          >
            {t('language', 'Language')}
          </Row>
          {!isLocal && (
            <>
              <div className="my-1 h-px bg-[color:var(--ag-hairline)]" />
              <div className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] hover:bg-boxHover">
                <Icon name="logout" size={16} className="text-textItemBlur" />
                <LogoutComponent />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
