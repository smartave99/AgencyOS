'use client';

import { useCallback, useMemo } from 'react';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useAgencyMe } from '@gitroom/frontend/components/agency/agency.hooks';
import type { IconName } from '@gitroom/frontend/components/agency/agency.icons';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Agency items: shown when the signed-in agency role holds this permission. */
  permission?: string;
  /** Workspace roles that may see the item (the platform's own pages). */
  roles?: string[];
  /** Hidden on a person's own computer, where there is one person and no sign-in. */
  hideWhenLocal?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * The one definition of where things are. The sidebar, the breadcrumb in the top bar and the
 * search palette all read it, so they can never disagree. Order follows the work: set up
 * a client, create the ad, get it approved, deliver it, then measure and grow.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        href: '/agency/dashboard',
        icon: 'grid',
        permission: 'dashboard:read',
      },
      {
        id: 'clients',
        label: 'Clients',
        href: '/agency/clients',
        icon: 'users',
        permission: 'client:read',
      },
      {
        id: 'campaigns',
        label: 'Campaigns',
        href: '/agency/campaigns',
        icon: 'megaphone',
        permission: 'campaign:read',
      },
      {
        id: 'approvals',
        label: 'Approvals',
        href: '/agency/approvals',
        icon: 'check',
        permission: 'campaign:read',
      },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      {
        id: 'telegram',
        label: 'Telegram',
        href: '/agency/telegram',
        icon: 'send',
        permission: 'destination:read',
      },
      {
        id: 'accounts',
        label: 'Connected accounts',
        href: '/agency/accounts',
        icon: 'link',
        permission: 'accounts:read',
      },
      {
        id: 'reports',
        label: 'Reports',
        href: '/agency/reports',
        icon: 'doc',
        permission: 'analytics:read',
      },
    ],
  },
  {
    id: 'grow',
    label: 'Grow',
    items: [
      {
        id: 'crm',
        label: 'Sales pipeline',
        href: '/agency/crm',
        icon: 'chart',
        permission: 'crm:read',
      },
      {
        id: 'leads',
        label: 'Leads',
        href: '/agency/leads',
        icon: 'users',
        permission: 'crm:read',
      },
      {
        id: 'knowledge',
        label: 'Knowledge base',
        href: '/agency/intelligence',
        icon: 'book',
        permission: 'intelligence:read',
      },
      {
        id: 'invoices',
        label: 'Invoices',
        href: '/agency/billing',
        icon: 'card',
        permission: 'billing:read',
      },
    ],
  },
  {
    id: 'scheduler',
    label: 'Social scheduler',
    items: [
      {
        id: 'calendar',
        label: 'Calendar',
        href: '/launches',
        icon: 'calendar',
      },
      { id: 'media', label: 'Media library', href: '/media', icon: 'image' },
      {
        id: 'analytics',
        label: 'Channel analytics',
        href: '/analytics',
        icon: 'bars',
      },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      {
        id: 'team',
        label: 'Team and roles',
        href: '/agency/team',
        icon: 'shield',
        permission: 'team:read',
        hideWhenLocal: true,
      },
      {
        id: 'portal',
        label: 'Client portal',
        href: '/agency/portal',
        icon: 'flag',
        permission: 'portal:view',
        hideWhenLocal: true,
      },
    ],
  },
];

/** Pinned to the bottom of the sidebar. */
export const NAV_FOOTER: NavItem[] = [
  { id: 'guide', label: 'Guide', href: '/guide', icon: 'help' },
  {
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    icon: 'sliders',
    roles: ['ADMIN', 'USER', 'SUPERADMIN'],
  },
];

export interface NavMatch {
  group?: NavGroup;
  item: NavItem;
}

/** The deepest item whose address is a prefix of the current page. */
export const matchNav = (pathname: string): NavMatch | undefined => {
  const all: NavMatch[] = [
    ...NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => ({ group, item }))
    ),
    ...NAV_FOOTER.map((item) => ({ item })),
  ];
  return all
    .filter(
      ({ item }) =>
        pathname === item.href || pathname.startsWith(`${item.href}/`)
    )
    .sort((a, b) => b.item.href.length - a.item.href.length)[0];
};

/**
 * Hides what the server would refuse anyway. This is a convenience, not a security boundary:
 * every /agency endpoint enforces the role itself. While the role is loading the menu is
 * left unfiltered so it does not flicker.
 */
export const useNavigation = () => {
  const user = useUser();
  const { isLocal } = useVariables();
  const { data: agency } = useAgencyMe();

  const allowed = useCallback(
    (item: NavItem) => {
      if (isLocal && item.hideWhenLocal) return false;
      if (item.roles && !item.roles.includes(user?.role as string))
        return false;
      if (!agency) return true;
      if (agency.role === 'CLIENT') return item.permission === 'portal:view';
      return !item.permission || agency.permissions.includes(item.permission);
    },
    [agency, isLocal, user?.role]
  );

  return useMemo(
    () => ({
      groups: NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter(allowed),
      })).filter((group) => group.items.length > 0),
      footer: NAV_FOOTER.filter(allowed),
    }),
    [allowed]
  );
};
