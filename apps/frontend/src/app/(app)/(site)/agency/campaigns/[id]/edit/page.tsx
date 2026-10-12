export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { CampaignFormComponent } from '@gitroom/frontend/components/agency/campaign-form.component';

export const metadata: Metadata = {
  title: 'Edit Campaign | AgencyOS',
  description: 'Edit a draft campaign',
};

export default async function EditCampaignPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  return <CampaignFormComponent campaignId={id} />;
}
