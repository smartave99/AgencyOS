export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyLeadsComponent } from '@gitroom/frontend/components/agency/leads.component';

export const metadata: Metadata = {
  title: 'Leads | AgencyOS',
  description: 'People who asked to hear from your agency on Telegram',
};

export default function AgencyLeadsPage() {
  return <AgencyLeadsComponent />;
}
