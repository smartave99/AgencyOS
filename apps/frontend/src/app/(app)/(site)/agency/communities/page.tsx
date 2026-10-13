export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { CommunitiesComponent } from '@gitroom/frontend/components/agency/communities.component';

export const metadata: Metadata = {
  title: 'Communities | AgencyOS',
  description:
    'Public Telegram communities: research, join and post where allowed',
};

export default function AgencyCommunitiesPage() {
  return <CommunitiesComponent />;
}
