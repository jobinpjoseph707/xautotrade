import React from 'react';

import { Empty, Page, PageHeader } from '../components/ui';

/** Placeholder until task 2.1 adds the gate engine. */
export function TestboardScreen() {
  return (
    <Page>
      <PageHeader title="Testboard" subtitle="Which stage each strategy has reached" />
      <Empty title="No verdicts yet" body="Each strategy will show its stage, its progress and a plain verdict here." />
    </Page>
  );
}
