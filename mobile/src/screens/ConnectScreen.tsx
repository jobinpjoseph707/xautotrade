import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';

import { loadAddresses, normaliseUrl, probeServer, saveAddresses, type AddressMode } from '../api';
import { Banner, Button, Card, Field, Segmented } from '../components/ui';
import { useApp } from '../store';
import { colors, font, space } from '../theme';

export function ConnectScreen() {
  const { connect, error, connection } = useApp();
  // Prefill whatever was saved. When a stored connection fails the app lands
  // back here, and showing a placeholder address instead of the one actually
  // in use made "Connect" silently retry the wrong machine.
  const [local, setLocal] = useState(connection?.baseUrl ?? '');
  const [tailscale, setTailscale] = useState('');
  const [mode, setMode] = useState<AddressMode>('auto');
  const [key, setKey] = useState(connection?.apiKey ?? '');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // A restore attempt resolves after first render, so adopt it when it arrives.
  useEffect(() => {
    if (connection?.baseUrl && !local) setLocal(connection.baseUrl);
    if (connection?.apiKey && !key) setKey(connection.apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.baseUrl, connection?.apiKey]);

  // Restore remembered addresses (kept separately from the active connection).
  useEffect(() => {
    void loadAddresses().then((a) => {
      if (a.local) setLocal((cur) => cur || a.local);
      if (a.tailscale) setTailscale(a.tailscale);
      setMode(a.mode);
    });
  }, []);

  const onConnect = async () => {
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
      // The API key is sent on every request regardless of transport.
      await connect({ baseUrl: target, apiKey: key.trim() });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const message = localError ?? error;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl * 2, width: '100%', maxWidth: 520, alignSelf: 'center' as const }}>
        <Text style={[font.h1, { marginBottom: space.xs }]}>XAutoTrade</Text>
        <Text style={[font.body, { marginBottom: space.xl }]}>
          Build, backtest and run MetaTrader 5 strategies from your phone.
        </Text>

        {message ? <Banner tone="critical">{message}</Banner> : null}

        <Card>
          <Text style={[font.h3, { marginBottom: space.md }]}>Connect to your server</Text>
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
            hint="The computer's LAN IPv4 (run ipconfig there). Not localhost — that would mean the phone itself."
          />
          <Field
            label="Tailscale address"
            value={tailscale}
            onChangeText={setTailscale}
            placeholder="http://100.x.y.z:4000  or  http://laptop-name.tailnet.ts.net:4000"
            keyboardType="url"
            hint="Shown in the Tailscale app for the computer. Works from anywhere while both devices are on your tailnet. Auto tries WiFi first, then Tailscale."
          />
          <Field
            label="API key"
            value={key}
            onChangeText={setKey}
            placeholder="paste the key printed by the server"
            hint="Printed in the server console on startup."
          />
          <Button title="Connect" onPress={onConnect} loading={busy} disabled={(!local && !tailscale) || !key} />
        </Card>

        <View style={{ marginTop: space.xl }}>
          <Text style={[font.label, { marginBottom: space.sm }]}>HOW THIS WORKS</Text>
          <Text style={[font.body, { marginBottom: space.md }]}>
            MetaTrader 5 on your phone cannot run automated strategies — Expert Advisors only execute in
            the desktop terminal. This app talks to a small server you run, which drives your MT5 account
            through MetaApi's cloud bridge.
          </Text>
          <Text style={font.body}>
            Start the server with{' '}
            <Text style={{ color: colors.text, fontWeight: '600' }}>npm run dev</Text>, and it will print
            its address and API key. With no MetaApi token set, it runs in paper mode on simulated data so
            you can explore everything safely.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
