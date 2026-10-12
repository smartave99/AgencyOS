'use client';

import React, { FC, useCallback } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

const FolderRow: FC<{ label: string; hint: string; folder: string }> = ({
  label,
  hint,
  folder,
}) => (
  <div className="flex flex-col gap-[4px]">
    <div className="text-[14px]">{label}</div>
    <div className="text-[12px] text-customColor18">{hint}</div>
    <div className="text-[14px] break-all select-text">{folder}</div>
  </div>
);

const StorageComponent: FC = () => {
  const t = useT();
  const { agencyDataFolder, agencyAiFolder, agencyStatusUrl } = useVariables();

  // The folder picker and the safe copy-and-switch live on the status page, which controls the
  // services that must stop while files move.
  const change = useCallback(() => {
    window.location.href = agencyStatusUrl!;
  }, [agencyStatusUrl]);

  return (
    <div className="flex flex-col">
      <h3 className="text-[20px]">{t('storage', 'Storage')}</h3>
      <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[24px]">
        <FolderRow
          label={t('storage_data_folder', 'Your data')}
          hint={t(
            'storage_data_folder_hint',
            'Database, uploaded images and videos, and logs.'
          )}
          folder={agencyDataFolder!}
        />
        <FolderRow
          label={t('storage_ai_folder', 'Local AI engine and models')}
          hint={t(
            'storage_ai_folder_hint',
            'Downloaded once. Models can take several GB, so they can live on another drive.'
          )}
          folder={agencyAiFolder!}
        />
        {!!agencyStatusUrl && (
          <div className="flex items-center gap-[16px]">
            <Button onClick={change}>
              {t('storage_change_location', 'Change location')}
            </Button>
            <div className="text-[12px] text-customColor18">
              {t(
                'storage_change_hint',
                'Files are copied and checked first. Nothing is deleted until you say so.'
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default StorageComponent;
