export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyAgentIntegrationsComponent } from '@gitroom/frontend/components/agency/agent.integrations.component';

export const metadata: Metadata = {
  title: 'Agent integrations | AgencyOS',
  description:
    'Let an AI agent look at your work and prepare drafts that you approve',
};

export default function AgencyAgentIntegrationsPage() {
  return <AgencyAgentIntegrationsComponent />;
}
