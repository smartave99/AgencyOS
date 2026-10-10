export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyApprovalsComponent } from '@gitroom/frontend/components/agency/approvals.component';

export const metadata: Metadata = {
  title: 'Approval Inbox | AgencyOS',
  description: 'Manager review queue for advertising campaigns',
};

export default function AgencyApprovalsPage() {
  return <AgencyApprovalsComponent />;
}
