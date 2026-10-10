export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyCampaignsComponent } from '@gitroom/frontend/components/agency/campaigns.component';

export const metadata: Metadata = {
  title: 'Campaign Management | AgencyOS',
  description: 'Manage multi-destination advertising campaigns',
};

export default function AgencyCampaignsPage() {
  return <AgencyCampaignsComponent />;
}
