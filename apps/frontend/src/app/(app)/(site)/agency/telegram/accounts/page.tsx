export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { TelegramAccountsComponent } from '@gitroom/frontend/components/agency/telegram.accounts.component';

export const metadata: Metadata = {
  title: 'Telegram accounts | AgencyOS',
  description: 'The Telegram accounts and bots your agency works through',
};

export default function AgencyTelegramAccountsPage() {
  return <TelegramAccountsComponent />;
}
