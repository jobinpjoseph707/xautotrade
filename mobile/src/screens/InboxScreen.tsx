import React from 'react';

import { Empty, Page, PageHeader } from '../components/ui';

/** Placeholder until task 1.4 replaces the Activity screen with the real Inbox. */
export function InboxScreen() {
  return (
    <Page>
      <PageHeader title="Inbox" subtitle="Everything that needs you will appear here" />
      <Empty title="Nothing needs you" body="Proposals, gate results, errors and safety actions will show up here." />
    </Page>
  );
}
