export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { GuideComponent } from '@gitroom/frontend/components/guide/guide.component';

export const metadata: Metadata = {
  title: "Guide | AgencyOS",
  description: "How to use AgencyOS: your first campaign, local model setup and shortcuts",
};

export default function Page() {
  return <GuideComponent />;
}
