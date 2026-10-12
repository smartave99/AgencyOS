export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyTeamComponent } from '@gitroom/frontend/components/agency/team.component';

export const metadata: Metadata = {
  title: 'Team | AgencyOS',
  description: 'Agency roles and who can do what',
};

export default function AgencyTeamPage() {
  return <AgencyTeamComponent />;
}
