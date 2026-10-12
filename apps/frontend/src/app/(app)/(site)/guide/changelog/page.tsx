export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { ChangelogComponent } from '@gitroom/frontend/components/guide/guide.component';

export const metadata: Metadata = {
  title: "What's new | AgencyOS",
  description: "Every change in every version of AgencyOS",
};

export default function Page() {
  return <ChangelogComponent />;
}
