'use client';

import { FC, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Icon } from '@gitroom/frontend/components/agency/agency.icons';
import {
  NavItem,
  useNavigation,
} from '@gitroom/frontend/components/new-layout/nav.config';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

const isActive = (pathname: string, item: NavItem) =>
  pathname === item.href || pathname.startsWith(`${item.href}/`);

const Item: FC<{ item: NavItem; collapsed: boolean; active: boolean }> = ({
  item,
  collapsed,
  active,
}) => {
  const t = useT();
  const label = t(`nav_${item.id}`, item.label);
  return (
    <Link
      href={item.href}
      prefetch
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group flex items-center gap-3 rounded-xl h-10 text-[14px] font-medium transition-colors',
        collapsed ? 'justify-center px-0 w-10 mx-auto' : 'px-3',
        active
          ? 'bg-[var(--ag-accent-soft)] text-[color:var(--ag-accent-text)]'
          : 'text-textItemBlur hover:bg-boxHover hover:text-newTextColor'
      )}
    >
      <Icon name={item.icon} size={18} />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
};

/**
 * The one navigation of the platform. On a wide screen it can be folded to icons; on a small
 * one it slides over the page. The groups follow the work: set up, create, deliver, grow.
 */
export const Sidebar: FC<{
  collapsed: boolean;
  open: boolean;
  onClose: () => void;
}> = ({ collapsed, open, onClose }) => {
  const pathname = usePathname();
  const { groups, footer } = useNavigation();
  const t = useT();

  useEffect(() => {
    onClose();
  }, [pathname]);

  return (
    <>
      {open && (
        <div
          className="hidden mobile:block fixed inset-0 z-[490] bg-[var(--ag-scrim)]"
          onClick={onClose}
        />
      )}
      <aside
        aria-label={t('main_navigation', 'Main navigation')}
        className={clsx(
          'ag-scope flex flex-col shrink-0 bg-newBgColorInner border-e border-[color:var(--ag-hairline)]',
          'sticky top-0 h-screen transition-[width] duration-200',
          collapsed ? 'w-[68px]' : 'w-[248px]',
          'mobile:fixed mobile:inset-y-0 mobile:start-0 mobile:z-[491] mobile:w-[272px] mobile:transition-transform',
          !open && 'mobile:-translate-x-full rtl:mobile:translate-x-full'
        )}
      >
        <div
          className={clsx(
            'flex items-center h-14 shrink-0 gap-3',
            collapsed ? 'justify-center' : 'px-5'
          )}
        >
          <svg
            width="30"
            height="30"
            viewBox="0 0 60 60"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <rect x="4" y="4" width="52" height="52" rx="14" fill="#6D4AFF" />
            <path
              d="M18 43L30 16L42 43M23 34H37"
              stroke="white"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {!collapsed && (
            <div className="flex flex-col leading-[1.15] min-w-0">
              <span className="text-[16px] font-semibold tracking-tight">
                AgencyOS
              </span>
              <span className="text-[11px] text-textItemBlur">
                by NextGen OS
              </span>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-5 scrollbar-thin">
          {groups.map((group) => (
            <div key={group.id} className="flex flex-col gap-0.5">
              {!collapsed ? (
                <div className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.06em] text-textItemBlur/80">
                  {t(`nav_group_${group.id}`, group.label)}
                </div>
              ) : (
                <div className="mx-auto my-1 h-px w-5 bg-[color:var(--ag-hairline)]" />
              )}
              {group.items.map((item) => (
                <Item
                  key={item.id}
                  item={item}
                  collapsed={collapsed}
                  active={isActive(pathname, item)}
                />
              ))}
            </div>
          ))}
        </nav>

        <div className="shrink-0 px-3 py-3 border-t border-[color:var(--ag-hairline)] flex flex-col gap-0.5">
          {footer.map((item) => (
            <Item
              key={item.id}
              item={item}
              collapsed={collapsed}
              active={isActive(pathname, item)}
            />
          ))}
        </div>
      </aside>
    </>
  );
};
