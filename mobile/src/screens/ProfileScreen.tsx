import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';

import {
  loadAddresses,
  normaliseUrl,
  probeServer,
  saveAddresses,
  type AddressMode,
} from '../api';
import { Banner, Button, Card, Field, Row, SectionTitle, Segmented, PageHeader, StatusPill } from '../components/ui';
import { confirmAction, notify } from '../confirm';
import { useApp } from '../store';
import { colors, font, space } from '../theme';

/**
 * Account/connection management, split out of Activity so logging in, logging
 * out, and switching servers all live in one predictable place instead of
 * being buried at the bottom of the log screen.
 *
 * Reuses the same fields and connect logic as the initial Connect gate
 * (ConnectScreen) — this is that same form, just reachable at any time and
 * pre-filled with whatever is currently active.
 */
export function ProfileScreen() {
  const { connect, disconnect, connection, connected, account, socketUp, error, api, refresh } = useApp();

  const [local, setLocal] = useState(connection?.baseUrl ?? '');
  const [tailscale, setTailscale] = useState('');
  const [mode, setMode] = useState<AddressMode>('auto');
  const [key, setKey] = useState(connection?.apiKey ?? '');
  const [busy, setBusy] = useState(false);
  const [panicBusy, setPanicBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Remembered addresses, same store the Connect gate reads/writes.
  useEffect(() => {
    void loadAddresses().then((a) => {
      if (a.local) setLocal((cur) => cur || a.local);
      if (a.tailscale) setTailscale((cur) => cur || a.tailscale);
      setMode(a.mode);
    });
  }, []);

  // Keep the fields matching whatever connection is actually active (e.g.
  // restored on launch, or switched from elsewhere).
  useEffect(() => {
    if (connection?.baseUrl) setLocal(connection.baseUrl);
    if (connection?.apiKey) setKey(connection.apiKey);
  }, [connection?.baseUrl, connection?.apiKey]);

  const doConnect = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const l = normaliseUrl(local);
      const t = normaliseUrl(tailscale);
      await saveAddresses({ local: l, tailscale: t, mode });
      let target = mode === 'tailscale' ? t : l;
      if (mode === 'auto') {
        // Prefer the LAN address (faster); fall back to the tunnel.
        if (l && (await probeServer(l))) target = l;
        else if (t && (await probeServer(t, 5000))) target = t;
        else target = l || t;
      }
      if (!target) throw new Error('Enter a server address for the selected mode.');
      if (!key.trim()) throw new Error('Enter the API key printed by the server.');
      await connect({ baseUrl: target, apiKey: key.trim() });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = () => {
    confirmAction(
      'Log out?',
      'The app forgets this server. Bots keep running on the server itself.',
      'Log out',
      async () => {
        setBusy(true);
        try {
          // Best-effort: the server is about to be forgotten, so this must not
          // block logging out if it fails (offline, key already invalid, etc).
          // Recorded server-side because the activity log lives there, not on
          // the phone -- and logs are cleared locally on disconnect anyway.
          if (api) await api.logClientEvent('logout', 'Logged out from the app.').catch(() => {});
          await disconnect();
        } finally {
          setBusy(false);
        }
      },
      { destructive: true },
    );
  };

  const doPanic = () => {
    if (!api) return;
    confirmAction(
      'Stop everything?',
      'This stops every bot and closes all positions they opened, at market. Positions you opened manually in MT5 are not touched.',
      'Stop & close',
      async () => {
        setPanicBusy(true);
        try {
          const r = await api.panic();
          await refresh();
          notify('Stopped', `All bots stopped. ${r.closed} position(s) closed.`);
        } catch (err) {
          notify('Failed', err instanceof Error ? err.message : String(err));
        } finally {
          setPanicBusy(false);
        }
      },
      { destructive: true },
    );
  };

  const message = localError ?? error;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xl, paddingBottom: space.xxl, width: '100%', maxWidth: 760, alignSelf: 'center' as const }}>
        <PageHeader
          title="Settings"
          subtitle="Server connection, account and session"
          right={<StatusPill status={connected ? 'running' : 'error'} label={connected ? 'Connected' : 'Logged out'} />}
        />

        {message ? <Banner tone="critical">{message}</Banner> : null}

        {connected ? (
          <Card style={{ marginBottom: space.md }}>
            <SectionTitle>Current session</SectionTitle>
            <Row label="Server" value={connection?.baseUrl ?? '—'} />
            <Row label="Live feed" value={socketUp ? 'websocket' : 'polling'} />
            <Row
              label="Mode"
              value={
                account?.mode === 'paper'
                  ? 'paper (simulated)'
                  : account?.mode === 'mt5mcp'
                    ? 'MT5-MCP bridge'
                    : account?.mode === 'metaapi'
                      ? 'MetaApi bridge'
                      : '—'
              }
            />
            <Row
              label="Live orders"
              value={account?.liveTradingAllowed ? 'allowed on real accounts' : 'demo accounts only'}
            />
            <Button
              title="Stop all bots & close positions"
              variant="danger"
              small
              style={{ marginTop: space.md }}
              loading={panicBusy}
              onPress={doPanic}
            />
            <Button
              title="Log out"
              variant="secondary"
              small
              style={{ marginTop: space.sm }}
              loading={busy}
              onPress={doDisconnect}
            />
          </Card>
        ) : (
          <Banner tone="warning">Not logged in. Fill in the fields below and connect.</Banner>
        )}

        <SectionTitle>{connected ? 'Switch server / reconnect' : 'Log in'}</SectionTitle>
        <Card>
          <Segmented<AddressMode>
            label="Connect via"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'local', label: 'Home WiFi' },
              { value: 'tailscale', label: 'Tailscale' },
            ]}
          />
          <Field
            label="Home WiFi address"
            value={local}
            onChangeText={setLocal}
            placeholder="http://192.168.1.2:4000"
            keyboardType="url"
            hint="The computer's LAN IPv4 (run ipconfig there). Not localhost — that would mean this device."
          />
          <Field
            label="Tailscale address"
            value={tailscale}
            onChangeText={setTailscale}
            placeholder="http://100.x.y.z:4000  or  http://laptop-name.tailnet.ts.net:4000"
            keyboardType="url"
            hint="Shown in the Tailscale app for the computer. Auto tries WiFi first, then Tailscale."
          />
          <Field
            label="API key"
            value={key}
            onChangeText={setKey}
            placeholder="paste the key printed by the server"
            hint="Printed in the server console on startup."
          />
          <Button
            title={connected ? 'Reconnect' : 'Connect'}
            onPress={doConnect}
            loading={busy}
            disabled={(!local && !tailscale) || !key}
          />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
