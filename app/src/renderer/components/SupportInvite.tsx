import { useState } from 'react';
import type { LiveDevice } from '@shared/types/live';
import type { SupportGap, SupportPlan } from '@shared/types/device';
import type { MessageKey } from '@shared/i18n';
import { MISSING_DEVICE_URL } from '@shared/links';
import { Panel } from './common';
import { Icon } from './icons';
import { sd } from '../state/bridge';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { hostFeatures } from '../state/host';

type T = ReturnType<typeof useT>;

const GAP: Record<SupportGap, MessageKey> = {
  keymap: 'support.gap.keymap',
  actuation: 'support.gap.actuation',
  lighting: 'support.gap.lighting',
  macros: 'support.gap.macros',
  deepSleep: 'support.gap.deepSleep',
  buttonActions: 'support.gap.buttonActions',
  receiver: 'support.gap.receiver',
};

interface Copy {
  title: MessageKey;
  lead?: string;
  body: MessageKey;
  action: MessageKey;
  strip?: string;
  stripAction?: MessageKey;
}

/** What the invitation says for a plan (DeviceUi.support). */
function copyFor(plan: SupportPlan, kind: LiveDevice['kind'], t: T): Copy {
  const list = plan.gaps.map((g) => t(GAP[g])).join(', ');
  if (plan.level === 'none') {
    return plan.record === 'report'
      ? {
          title: 'support.title.add',
          body: 'support.body.unknown',
          action: 'support.action.report',
        }
      : { title: 'support.title.add', body: 'support.body.all', action: 'support.action.all' };
  }
  if (plan.level === 'class') {
    return {
      title: 'support.title.name',
      body: 'support.body.class',
      action: 'support.action.report',
      strip: t('support.strip.class'),
      stripAction: 'support.strip.name',
    };
  }
  const steps = Array.isArray(plan.record) && plan.record.some((s) => s !== 'specific');
  return {
    title: 'support.title.complete',
    lead: t('support.gaps', { list }),
    body: steps ? 'support.body.steps' : 'support.body.specific',
    action: steps ? 'support.action.steps' : 'support.action.specific',
    strip: t(kind === 'keyboard' ? 'support.strip.keyboard' : 'support.strip.mouse', { list }),
    stripAction: 'support.strip.add',
  };
}

/**
 * The invitation's buttons. On the desktop the main one starts the device
 * report tool for this device (main/reportTool.ts); on Windows it first says
 * that Shark Deck closes, since the tool records the official software,
 * which must be the only one talking to the device. Elsewhere — the browser
 * edition, a demo device, or a tool that would not start — it opens the
 * "Missing a device?" page.
 */
function Actions({ device, plan, copy }: { device: LiveDevice; plan: SupportPlan; copy: Copy }) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const windows = useStore((s) => s.platformInfo?.os === 'win32');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const launch = hostFeatures.reportTool && !device.simulated;
  // Off Windows the tool makes the report alone: say so, and name the button for it.
  const reportOnly = launch && !windows && plan.record !== 'report';
  const howto = () => void sd.openExternal(MISSING_DEVICE_URL);
  const run = async () => {
    setBusy(true);
    const r = await sd
      .openReportTool(device.id)
      .catch((e: unknown) => ({ ok: false, error: String(e), quitting: false }));
    setBusy(false);
    setAsking(false);
    if (!r.ok) {
      toast('err', t('support.failed', { error: r.error ?? '' }));
      howto();
    } else if (!r.quitting) toast('info', t('support.opened'));
  };
  const start = () => {
    if (!launch) howto();
    else if (windows) setAsking(true);
    else void run();
  };
  if (asking) {
    return (
      <div className="support-confirm" role="alertdialog" aria-label={t(copy.action)}>
        <p className="hint">{t('support.confirm')}</p>
        <div className="support-actions">
          <button className="btn" disabled={busy} onClick={() => setAsking(false)}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void run()}>
            {t('support.confirm.ok')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {reportOnly && <p className="hint support-note">{t('support.unix')}</p>}
      <div className="support-actions">
        <button className="btn" onClick={howto}>
          {t('support.howto')}
        </button>
        <button className="btn primary" disabled={busy} onClick={start}>
          {t(reportOnly ? 'support.action.report' : copy.action)}
        </button>
      </div>
    </>
  );
}

/**
 * Asks the owner of a device Shark Deck does not fully support to record what
 * is missing with the device report tool (DeviceUi.support, from
 * main/devices/support.ts). Three places: inside the "Not supported yet"
 * panel (`identity`), a panel of the Device tab (`panel`, gate `dev.support`),
 * and a one-line strip above the other tabs (`strip`), whose button leads to
 * that panel.
 */
export function SupportInvite({
  device,
  variant,
  onOpen,
}: {
  device: LiveDevice;
  variant: 'identity' | 'panel' | 'strip';
  onOpen?: () => void;
}) {
  const t = useT();
  const plan = device.ui.support;
  if (!plan) return null;
  const copy = copyFor(plan, device.kind, t);
  if (variant === 'strip') {
    if (!copy.strip || !copy.stripAction) return null;
    return (
      <div className="support-strip">
        <Icon name="info" />
        <span>{copy.strip}</span>
        <button className="btn" onClick={onOpen}>
          {t(copy.stripAction)}
        </button>
      </div>
    );
  }
  if (variant === 'identity') {
    if (plan.level !== 'none') return null;
    return (
      <div className="support-invite support-in-identity">
        <h5>{t(copy.title)}</h5>
        <p className="hint">{t(copy.body)}</p>
        <Actions device={device} plan={plan} copy={copy} />
      </div>
    );
  }
  if (plan.level === 'none') return null;
  return (
    <Panel title={t(copy.title)} className="support-invite">
      {copy.lead && <p className="support-lead">{copy.lead}</p>}
      <p className="hint">{t(copy.body)}</p>
      <Actions device={device} plan={plan} copy={copy} />
    </Panel>
  );
}
