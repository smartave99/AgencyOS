export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { FeaturesComponent } from '@gitroom/frontend/components/guide/guide.component';

export const metadata: Metadata = {
  title: "Features | AgencyOS",
  description: "What every part of AgencyOS is for and how to use it",
};

export default function Page() {
  return <FeaturesComponent />;
}
