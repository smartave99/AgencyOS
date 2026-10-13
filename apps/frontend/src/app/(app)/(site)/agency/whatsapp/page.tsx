export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { AgencyWhatsappComponent } from '@gitroom/frontend/components/agency/whatsapp.component';

export const metadata: Metadata = {
  title: 'WhatsApp | AgencyOS',
  description:
    'Prepare WhatsApp messages for people who agreed to hear from you and send each one yourself',
};

export default function AgencyWhatsappPage() {
  return <AgencyWhatsappComponent />;
}
