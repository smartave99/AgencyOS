export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyDashboardComponent } from '@gitroom/frontend/components/agency/dashboard.component';

export const metadata: Metadata = {
  title: 'Executive Agency Dashboard | AgencyOS',
  description: 'Multi-tenant advertising agency operating dashboard',
};

export default function AgencyDashboardPage() {
  return <AgencyDashboardComponent />;
}
