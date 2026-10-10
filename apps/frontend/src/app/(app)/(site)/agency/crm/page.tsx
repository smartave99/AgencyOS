export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyCrmComponent } from '@gitroom/frontend/components/agency/crm.component';

export const metadata: Metadata = {
  title: 'Agency CRM & Sales | AgencyOS',
  description: 'Sales pipeline and lead management',
};

export default function AgencyCrmPage() {
  return <AgencyCrmComponent />;
}
