export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyClientsComponent } from '@gitroom/frontend/components/agency/clients.component';

export const metadata: Metadata = {
  title: 'Client Management | AgencyOS',
  description: 'Manage advertising clients and customer accounts',
};

export default function AgencyClientsPage() {
  return <AgencyClientsComponent />;
}
