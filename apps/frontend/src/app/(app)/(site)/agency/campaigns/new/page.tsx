export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { CampaignWizardComponent } from '@gitroom/frontend/components/agency/campaign-wizard.component';

export const metadata: Metadata = {
  title: 'Campaign Builder | AgencyOS',
  description: 'Create multi-destination advertising campaign wizard',
};

export default function NewCampaignPage() {
  return <CampaignWizardComponent />;
}
