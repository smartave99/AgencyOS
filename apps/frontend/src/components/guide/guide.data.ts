'use client';

import { useCallback, useEffect, useState } from 'react';
import releasesJson from '@gitroom/helpers/changelog/releases.json';
import featuresJson from '@gitroom/helpers/changelog/features.json';
import type { IconName } from '@gitroom/frontend/components/agency/agency.icons';

export type ChangeType =
  | 'added'
  | 'improved'
  | 'changed'
  | 'fixed'
  | 'security';

export interface Release {
  version: string;
  date: string;
  title: string;
  summary: string;
  changes: Array<{ type: ChangeType; area: string; text: string }>;
  notes?: string[];
}

export interface Feature {
  id: string;
  group: string;
  title: string;
  href: string;
  icon: IconName;
  status: 'ready' | 'needs-setup' | 'partial' | 'experimental';
  summary: string;
  steps: string[];
  needs?: string[];
  tips?: string[];
  hideWhenLocal?: boolean;
}

export interface FeatureGroup {
  id: string;
  title: string;
  blurb: string;
}

// The same files the release notes and CHANGELOG.md are made from.
export const RELEASES = releasesJson.releases as Release[];
export const FEATURES = featuresJson.features as Feature[];
export const FEATURE_GROUPS = featuresJson.groups as FeatureGroup[];

/** The version this build of the app is. The app and its change history ship together. */
export const CURRENT_VERSION = RELEASES[0].version;

const SEEN_KEY = 'agencyos.seenVersion';
const SEEN_EVENT = 'agencyos:seen';

/** Whether this version's "What's new" has been opened since the update. */
export const useWhatsNew = () => {
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    const read = () => {
      try {
        setUnseen(localStorage.getItem(SEEN_KEY) !== CURRENT_VERSION);
      } catch {
        /* storage can be blocked; show nothing rather than nag */
      }
    };
    read();
    window.addEventListener(SEEN_EVENT, read);
    return () => window.removeEventListener(SEEN_EVENT, read);
  }, []);
  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, CURRENT_VERSION);
    } catch {
      /* the badge simply returns next visit */
    }
    window.dispatchEvent(new Event(SEEN_EVENT));
  }, []);
  return { unseen, markSeen };
};
