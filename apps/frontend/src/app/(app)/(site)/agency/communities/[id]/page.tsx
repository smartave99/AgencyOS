export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { CommunityDetailComponent } from '@gitroom/frontend/components/agency/community-detail.component';

export const metadata: Metadata = {
  title: 'Community | AgencyOS',
  description: 'A Telegram community: where it stands, and what comes next',
};

export default async function AgencyCommunityPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  return <CommunityDetailComponent id={id} />;
}
