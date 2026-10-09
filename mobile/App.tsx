import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ChatScreen } from './src/screens/ChatScreen';
import { BacktestScreen } from './src/screens/BacktestScreen';
import { BotDetailScreen } from './src/screens/BotDetailScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { HelpScreen } from './src/screens/HelpScreen';
import { JournalScreen } from './src/screens/JournalScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { StrategiesScreen } from './src/screens/StrategiesScreen';
import { SimpleCreate } from './src/screens/SimpleCreate';
import { StrategyEditor } from './src/screens/StrategyEditor';
import { TestboardScreen } from './src/screens/TestboardScreen';
import { Button, StatusPill } from './src/components/ui';
import { confirmAction, notify } from './src/confirm';
import { useLayout } from './src/layout';
import { NAV, type Tab } from './src/logic/nav';
import { AppProvider, useApp } from './src/store';
import { colors, font, layout, space } from './src/theme';
import type { Strategy } from './src/types';

/**
 * A hand-rolled tab shell plus two full-screen routes (editor, backtest).
 * At this size a navigation library would add dependency surface without
 * adding anything the app actually uses.
 *
 * SafeAreaView comes from react-native-safe-area-context, NOT from
 * react-native — the built-in one is a no-op on Android, which put the
 * header and back button underneath the status bar.
 */
function Shell() {
  const { ready, connected } = useApp();
  const { wide } = useLayout();
  const [tab, setTabRaw] = useState<Tab>('dashboard');
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [backtesting, setBacktesting] = useState<Strategy | null>(null);
  const [detailing, setDetailing] = useState<Strategy | null>(null);
  const [creating, setCreating] = useState(false);

  // Switching sections always leaves any open full-screen route.
  const setTab = useCallback((t: Tab) => {
    setEditing(null);
    setBacktesting(null);
    setDetailing(null);
    setCreating(false);
    setTabRaw(t);
  }, []);

  // Desktop keyboard shortcuts: 1–N jump between sections (ignored while typing).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) setTab(NAV[n - 1].tab);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTab]);

  if (!ready) {
    return (
      <View style={[s.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!connected) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ConnectScreen />
      </SafeAreaView>
    );
  }

  // The active full-screen route, if any (create → backtest → detail → editor).
  let route: React.ReactNode = null;
  if (creating) {
    route = (
      <SimpleCreate
        onClose={() => setCreating(false)}
        onCreated={(strategy, openEditor) => {
          setCreating(false);
          if (openEditor) setEditing(strategy);
          else setBacktesting(strategy);
        }}
      />
    );
  } else if (backtesting) {
    route = <BacktestScreen strategy={backtesting} onClose={() => setBacktesting(null)} />;
  } else if (detailing) {
    route = <BotDetailScreen strategy={detailing} onClose={() => setDetailing(null)} />;
  } else if (editing) {
    route = <StrategyEditor strategy={editing} onClose={() => setEditing(null)} onBacktest={(st) => setBacktesting(st)} />;
  }

  const page = route ?? (
    <>
      {tab === 'dashboard' && (
        <DashboardScreen
          onOpenStrategies={() => setTab('strategies')}
          onOpenBot={(st) => setDetailing(st)}
          onOpenActivity={() => setTab('inbox')}
        />
      )}
      {tab === 'strategies' && (
        <StrategiesScreen
          onEdit={setEditing}
          onBacktest={(st) => setBacktesting(st)}
          onDetails={(st) => setDetailing(st)}
          onNew={() => setCreating(true)}
        />
      )}
      {tab === 'journal' && <JournalScreen />}
      {tab === 'agents' && <ChatScreen />}
      {tab === 'inbox' && <InboxScreen />}
      {tab === 'testboard' && <TestboardScreen />}
      {tab === 'profile' && <ProfileScreen />}
      {tab === 'help' && <HelpScreen />}
    </>
  );

  // Desktop: persistent sidebar, routes open inside the content area.
  if (wide) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <Sidebar tab={tab} setTab={setTab} />
          <View style={{ flex: 1 }}>{page}</View>
        </View>
      </SafeAreaView>
    );
  }

  // Phone: full-screen routes, bottom tab bar otherwise.
  if (route) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
        {route}
      </SafeAreaView>
    );
  }
  return (
    // The tab bar draws its own bottom padding, so this view owns only the top.
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right']}>
      <View style={{ flex: 1 }}>{page}</View>
      <TabBar tab={tab} setTab={setTab} />
    </SafeAreaView>
  );
}

const SIDEBAR_COLLAPSED_KEY = 'xat.sidebar.collapsed';

function Sidebar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { account, bots, socketUp, api, refresh } = useApp();
  const running = Object.values(bots).filter((b) => b.status === 'running').length;
  const openCount = new Set(Object.values(bots).flatMap((b) => b.openPositions.map((p) => p.id))).size;
  const [busy, setBusy] = useState(false);
  // Collapsible to an icon-only rail — the sidebar's job is navigation, not
  // permanently occupying 232px of a trading screen. Remembered per device.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(SIDEBAR_COLLAPSED_KEY)
      .then((v) => { if (v === '1') setCollapsed(true); })
      .catch(() => undefined);
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      AsyncStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0').catch(() => undefined);
      return next;
    });
  };

  const panic = () =>
    confirmAction(
      'Stop everything?',
      'Stops every bot and closes all positions they opened, at market. Positions you opened manually in MT5 are not touched.',
      'Stop & close',
      async () => {
        setBusy(true);
        try {
          const r = await api!.panic();
          await refresh();
          notify('Stopped', `All bots stopped. ${r.closed} position(s) closed.`);
        } catch (err) {
          notify('Failed', err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      },
      { destructive: true },
    );

  return (
    <View style={[s.sidebar, collapsed && s.sidebarCollapsed]} accessibilityRole={'navigation' as any}>
      <View style={[s.brand, collapsed && s.brandCollapsed]}>
        <View style={s.brandMark}>
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>XA</Text>
        </View>
        {!collapsed ? (
          <>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>XAutoTrade</Text>
              <Text style={font.small} numberOfLines={1}>MT5 algo desk</Text>
            </View>
            <Pressable onPress={toggleCollapsed} hitSlop={8} accessibilityRole="button" accessibilityLabel="Collapse sidebar" style={s.collapseBtn}>
              <Text style={{ color: colors.muted, fontSize: 13 }}>«</Text>
            </Pressable>
          </>
        ) : null}
      </View>
      {collapsed ? (
        <Pressable onPress={toggleCollapsed} hitSlop={8} accessibilityRole="button" accessibilityLabel="Expand sidebar" style={[s.collapseBtn, s.collapseBtnStandalone]}>
          <Text style={{ color: colors.muted, fontSize: 13 }}>»</Text>
        </Pressable>
      ) : null}

      <View style={{ gap: 2 }}>
        {NAV.map((n, i) => {
          const active = n.tab === tab;
          return (
            <Pressable
              key={n.tab}
              onPress={() => setTab(n.tab)}
              accessibilityRole="link"
              accessibilityState={{ selected: active }}
              accessibilityLabel={n.label}
              accessibilityHint={`${n.hint}. Shortcut ${i + 1}.`}
              style={(state) => [
                s.navItem,
                collapsed && s.navItemCollapsed,
                active && s.navItemActive,
                (state as { hovered?: boolean }).hovered && !active && { backgroundColor: colors.surfaceAlt },
              ]}
            >
              <Text style={{ width: 20, textAlign: 'center', fontSize: 15, color: active ? colors.accent : colors.muted }}>{n.icon}</Text>
              {!collapsed ? (
                <>
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: active ? '600' : '500', color: active ? colors.text : colors.textSecondary }} numberOfLines={1}>
                    {n.label}
                  </Text>
                  <Text style={s.kbd}>{i + 1}</Text>
                </>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />

      {!collapsed ? (
        <View style={s.sideCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={font.small}>{account?.name || account?.server || 'Account'}</Text>
            <StatusPill status={account?.type === 'demo' ? 'running' : 'error'} label={account?.type === 'demo' ? 'Demo' : 'Live'} />
          </View>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 6 }} numberOfLines={1}>
            {account ? account.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
          </Text>
          <Text style={font.small}>Equity {account?.currency ?? ''}</Text>
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: space.sm }} />
          <Text style={font.small}>
            {running} bot{running === 1 ? '' : 's'} running · {openCount} open
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Text style={{ color: socketUp ? colors.good : colors.warning, fontSize: 9 }}>{socketUp ? '●' : '◐'}</Text>
            <Text style={font.small}>{socketUp ? 'Live feed connected' : 'Polling every 5s'}</Text>
          </View>
        </View>
      ) : (
        <View
          style={s.sideCardCollapsed}
          accessibilityLabel={`${account?.type === 'demo' ? 'Demo' : 'Live'} account. ${running} bot${running === 1 ? '' : 's'} running, ${openCount} open. ${socketUp ? 'Live feed connected' : 'Polling every 5 seconds'}.`}
        >
          <View style={[s.collapsedDot, { backgroundColor: account?.type === 'demo' ? colors.good : colors.criticalStrong }]} />
          <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 5 }}>{running}</Text>
          <View style={[s.collapsedDot, { width: 6, height: 6, marginTop: 6, backgroundColor: socketUp ? colors.good : colors.warning }]} />
        </View>
      )}

      {collapsed ? (
        <Pressable
          onPress={panic}
          accessibilityRole="button"
          accessibilityLabel="Stop all bots"
          style={({ pressed }) => [s.collapsedPanicBtn, pressed && { opacity: 0.85 }]}
        >
          {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontSize: 15 }}>■</Text>}
        </Pressable>
      ) : (
        <Button title="Stop all bots" variant="danger" small icon="■" loading={busy} onPress={panic} style={{ marginTop: space.sm }} />
      )}
    </View>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <SafeAreaView edges={['bottom']} style={s.tabBar}>
      <View style={{ flexDirection: 'row' }}>
        {NAV.map((n) => (
          <TabButton key={n.tab} label={n.label} icon={n.icon} active={tab === n.tab} onPress={() => setTab(n.tab)} />
        ))}
      </View>
    </SafeAreaView>
  );
}

function TabButton({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={s.tab} hitSlop={8} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label}>
      <Text style={{ fontSize: 18, color: active ? colors.accent : colors.muted }}>{icon}</Text>
      <Text style={[font.small, { fontSize: 10 }, active && { color: colors.accent, fontWeight: '600' }]} numberOfLines={1} adjustsFontSizeToFit>
        {label}
      </Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabBar: {
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingTop: space.sm, paddingBottom: space.sm, minHeight: 52 },
  sidebar: {
    width: layout.sidebar,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    paddingTop: space.lg,
  },
  sidebarCollapsed: { width: layout.sidebarCollapsed, paddingHorizontal: space.xs, alignItems: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, marginBottom: space.xl },
  brandCollapsed: { justifyContent: 'center', paddingHorizontal: 0, marginBottom: space.sm },
  brandMark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapseBtn: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  collapseBtnStandalone: { alignSelf: 'center', marginBottom: space.lg, borderWidth: 1, borderColor: colors.border },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    height: 38,
    borderRadius: 8,
  },
  navItemCollapsed: { paddingHorizontal: 0, justifyContent: 'center', width: 40, alignSelf: 'center' },
  navItemActive: { backgroundColor: colors.accentDim },
  kbd: {
    color: colors.muted,
    fontSize: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  sideCard: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: space.md,
  },
  sideCardCollapsed: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: space.sm,
    alignItems: 'center',
    width: '100%',
  },
  collapsedDot: { width: 8, height: 8, borderRadius: 4 },
  collapsedPanicBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.criticalStrong,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: space.sm,
  },
});
