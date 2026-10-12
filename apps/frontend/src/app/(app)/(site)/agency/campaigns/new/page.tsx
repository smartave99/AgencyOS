export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { CampaignFormComponent } from '@gitroom/frontend/components/agency/campaign-form.component';

export const metadata: Metadata = {
  title: 'New Campaign | AgencyOS',
  description:
    'Create an advertising campaign for authorized Telegram destinations',
};

export default function NewCampaignPage() {
  return <CampaignFormComponent />;
}
