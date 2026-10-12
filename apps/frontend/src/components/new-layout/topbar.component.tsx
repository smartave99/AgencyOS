'use client';

import { FC, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Icon } from '@gitroom/frontend/components/agency/agency.icons';
import { openCommandPalette } from '@gitroom/frontend/components/agency/command-palette.component';
import { matchNav } from '@gitroom/frontend/components/new-layout/nav.config';
import { AccountMenu } from '@gitroom/frontend/components/new-layout/account.menu';
import { openCopilot } from '@gitroom/frontend/components/new-layout/copilot.panel';
import { useCan } from '@gitroom/frontend/components/agency/agency.hooks';
import { useTheme } from '@gitroom/frontend/components/layout/theme';
import NotificationComponent from '@gitroom/frontend/components/notifications/notification.component';
import { OrganizationSelector } from '@gitroom/frontend/components/layout/organization.selector';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

const IconButton: FC<{
  label: string;
  icon: 'menu' | 'panel' | 'sun' | 'moon' | 'sparkles';
  onClick: () => void;
  className?: string;
}> = ({ label, icon, onClick, className }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className={clsx(
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-textItemBlur hover:bg-boxHover hover:text-newTextColor',
      className
    )}
  >
    <Icon name={icon} size={18} />
  </button>
);

/** Where you are, a search that reaches everything, and the personal controls. */
export const TopBar: FC<{
  onMenu: () => void;
  onToggleCollapse: () => void;
}> = ({ onMenu, onToggleCollapse }) => {
  const t = useT();
  const pathname = usePathname();
  const { isLocal } = useVariables();
  const { isClient } = useCan();
  const { resolved, setPreference } = useTheme();
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/i.test(navigator.platform));
  }, []);

  const here = matchNav(pathname);
  const page = here ? t(`nav_${here.item.id}`, here.item.label) : 'AgencyOS';
  const section = here?.group
    ? t(`nav_group_${here.group.id}`, here.group.label)
    : undefined;

  return (
    <header className="ag-scope ag-drag ag-titlebar-end sticky top-0 z-[40] flex h-14 shrink-0 items-center gap-2 border-b border-[color:var(--ag-hairline)] bg-newBgColorInner px-4 mobile:px-3">
      <IconButton
        label={t('open_menu', 'Open menu')}
        icon="menu"
        onClick={onMenu}
        className="hidden mobile:flex"
      />
      <IconButton
        label={t('toggle_sidebar', 'Show or hide the sidebar')}
        icon="panel"
        onClick={onToggleCollapse}
        className="mobile:hidden"
      />

      <nav
        aria-label={t('breadcrumb', 'Breadcrumb')}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-[14px]"
      >
        {section && (
          <>
            <span className="truncate text-textItemBlur mobile:hidden">
              {section}
            </span>
            <Icon
              name="chevron-right"
              size={14}
              className="text-textItemBlur/60 mobile:hidden rtl:rotate-180"
            />
          </>
        )}
        <span
          aria-current="page"
          className="truncate text-[15px] font-semibold tracking-tight"
        >
          {page}
        </span>
      </nav>

      <button
        type="button"
        onClick={openCommandPalette}
        aria-label={t('search', 'Search')}
        className="hidden h-9 w-[320px] items-center gap-2.5 rounded-xl border border-[color:var(--ag-hairline)] bg-[var(--ag-neutral-bg)] px-3 text-[13px] text-textItemBlur hover:text-newTextColor sm:flex lg:w-[380px]"
      >
        <Icon name="search" size={15} />
        <span className="flex-1 text-start">
          {t('search_everything', 'Search pages and campaigns')}
        </span>
        <kbd className="rounded-md bg-newBgColorInner px-1.5 py-0.5 text-[11px] leading-none">
          {mac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      <div className="flex flex-1 items-center justify-end gap-1">
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label={t('search', 'Search')}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-textItemBlur hover:bg-boxHover hover:text-newTextColor sm:hidden"
        >
          <Icon name="search" size={18} />
        </button>
        {!isLocal && <OrganizationSelector />}
        {!isClient && (
          <IconButton
            label={t('open_copilot', 'Copilot (Ctrl+J)')}
            icon="sparkles"
            onClick={() => openCopilot()}
          />
        )}
        <IconButton
          label={
            resolved === 'dark'
              ? t('switch_to_light', 'Switch to light theme')
              : t('switch_to_dark', 'Switch to dark theme')
          }
          icon={resolved === 'dark' ? 'sun' : 'moon'}
          onClick={() => setPreference(resolved === 'dark' ? 'light' : 'dark')}
        />
        <NotificationComponent />
        <div className="ms-1">
          <AccountMenu />
        </div>
      </div>
    </header>
  );
};
