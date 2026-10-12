export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { CampaignDetailComponent } from '@gitroom/frontend/components/agency/campaign-detail.component';

export const metadata: Metadata = {
  title: 'Campaign | AgencyOS',
  description: 'Campaign status, delivery receipts and review history',
};

export default async function CampaignDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  return <CampaignDetailComponent id={id} />;
}
