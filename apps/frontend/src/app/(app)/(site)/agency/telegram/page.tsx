export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyTelegramComponent } from '@gitroom/frontend/components/agency/telegram.component';

export const metadata: Metadata = {
  title: 'Telegram Management | AgencyOS',
  description: 'Telegram destination registry, bot verification, and posting telemetry',
};

export default function AgencyTelegramPage() {
  return <AgencyTelegramComponent />;
}
