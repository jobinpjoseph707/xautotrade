/** Pure navigation data (no React Native imports) so it can be unit-tested. */
export type Tab = 'dashboard' | 'inbox' | 'strategies' | 'testboard' | 'journal' | 'agents' | 'profile' | 'help';

export interface NavItem {
  tab: Tab;
  label: string;
  icon: string;
  hint: string;
}

export const NAV: NavItem[] = [
  { tab: 'dashboard', label: 'Dashboard', icon: '◧', hint: 'Account, bots and open positions' },
  { tab: 'inbox', label: 'Inbox', icon: '✉', hint: 'Everything that needs you' },
  { tab: 'strategies', label: 'Strategies', icon: '◈', hint: 'Build, backtest and run' },
  { tab: 'testboard', label: 'Testboard', icon: '✓', hint: 'Which stage each strategy has reached' },
  { tab: 'journal', label: 'Journal', icon: '▤', hint: 'Every trade, filterable' },
  { tab: 'agents', label: 'Agents', icon: '✦', hint: 'AI strategy agents' },
  { tab: 'profile', label: 'Settings', icon: '◐', hint: 'Connection and account' },
  { tab: 'help', label: 'Help', icon: '?', hint: 'What to do each day, and when something goes wrong' },
];
