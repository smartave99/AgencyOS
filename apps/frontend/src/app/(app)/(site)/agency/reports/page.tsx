export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyReportsComponent } from '@gitroom/frontend/components/agency/reports.component';

export const metadata: Metadata = {
  title: 'Reports | AgencyOS',
  description: 'Publishing results counted from stored send receipts',
};

export default function AgencyReportsPage() {
  return <AgencyReportsComponent />;
}
