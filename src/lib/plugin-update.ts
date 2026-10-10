import { useUiStore, toast } from './ui-store';
import { t, fmt } from '../i18n';
import { compareVersions } from '../whats-new';

// Inside DeepSeek Harness the canvas is the plugin's bundle; a newer plugin
// on the registry is a fact the host learns once a day and the canvas shows
// once per version: an entry in the ⋯ menu with the update command, and a
// toast the first time. Nothing updates by itself — the person runs the
// harness's own command.
const NOTIFIED_KEY = 'thoughtdag.pluginUpdateNotified';
// `add dsh-dotline@<version>` rewrites the profile's spec back to the
// registry, so it works for a profile that installed from a release file too
// (`update` re-resolves the same file URL and never moves). The exact version
// matters: pnpm 11 holds back versions published within the last day when it
// resolves a tag like `latest`, but installs a named version at once.
export function pluginUpdateCommand(latest?: string | null): string {
  return `dsh plugin --profile web add dsh-dotline@${latest || 'latest'}`;
}

export async function bootPluginUpdateCheck(apiBase: string): Promise<void> {
  try {
    const r = await fetch(apiBase.replace(/\/+$/, '') + '/version', { credentials: 'same-origin' });
    if (!r.ok) return;
    const j = await r.json() as { version?: string | null; latest?: string | null };
    if (!j.version || !j.latest || compareVersions(j.latest, j.version) <= 0) return;
    useUiStore.getState().setPluginUpdate({ current: j.version, latest: j.latest });
    let notified: string | null = null;
    try { notified = localStorage.getItem(NOTIFIED_KEY); } catch { /* ignore */ }
    if (notified !== j.latest) {
      try { localStorage.setItem(NOTIFIED_KEY, j.latest); } catch { /* ignore */ }
      toast('info', fmt(t('plugin.updateAvailable'), { v: j.latest }), 9000);
    }
  } catch { /* the host did not answer; nothing to say */ }
}
