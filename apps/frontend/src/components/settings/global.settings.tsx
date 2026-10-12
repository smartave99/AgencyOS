'use client';

import React from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import dynamic from 'next/dynamic';
import AuthenticationComponent from '@gitroom/frontend/components/settings/authentication.component';
import EmailNotificationsComponent from '@gitroom/frontend/components/settings/email-notifications.component';
import ShortlinkPreferenceComponent from '@gitroom/frontend/components/settings/shortlink-preference.component';
import DeleteAccountComponent from '@gitroom/frontend/components/settings/delete-account.component';
import { useVariables } from '@gitroom/react/helpers/variable.context';

const MetricComponent = dynamic(
  () => import('@gitroom/frontend/components/settings/metric.component'),
  {
    ssr: false,
  }
);

export const GlobalSettings = () => {
  const t = useT();
  const { isLocal } = useVariables();
  // On a person's own computer there is no sign-in, no email service and nothing to close.
  return (
    <div className="flex flex-col">
      <h3 className="text-[20px]">{t('general', 'General')}</h3>
      {!isLocal && <AuthenticationComponent />}
      <MetricComponent />
      {!isLocal && <EmailNotificationsComponent />}
      <ShortlinkPreferenceComponent />
      {!isLocal && <DeleteAccountComponent />}
    </div>
  );
};
