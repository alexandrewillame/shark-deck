import { useState } from 'react';
import type { LiveDevice } from '@shared/types/live';
import type { SupportGap, SupportPlan, SupportTopic } from '@shared/types/device';
import type { MessageKey } from '@shared/i18n';
import { MISSING_DEVICE_URL } from '@shared/links';
import { ConfirmDialog, Panel } from './common';
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
  mediaKeys: 'support.gap.mediaKeys',
  receiver: 'support.gap.receiver',
};

/** A list the invitation is about: its heading, then each item highlighted. */
interface Listed {
  heading: string;
  items: string[];
}

interface Copy {
  title: MessageKey;
  /** What the button records, as lists of highlighted items: no paragraph
   *  between them and the button (an owner found one in between confusing). */
  lists?: Listed[];
  /** Said under the title where no list says it (a whole device, a report). */
  body?: MessageKey;
  action: MessageKey;
  strip?: string;
  stripAction?: MessageKey;
}

const TOPIC: Record<SupportTopic, MessageKey> = {
  keys: 'support.topic.keys',
  knob: 'support.topic.knob',
  lighting: 'support.topic.lighting',
  actuation: 'support.topic.actuation',
  keyModes: 'support.topic.keyModes',
  switches: 'support.topic.switches',
  options: 'support.topic.options',
  profiles: 'support.topic.profiles',
  pollRate: 'support.topic.pollRate',
  macros: 'support.topic.macros',
  dpi: 'support.topic.dpi',
  sensor: 'support.topic.sensor',
  buttons: 'support.topic.buttons',
  power: 'support.topic.power',
  response: 'support.topic.response',
  pairing: 'support.topic.pairing',
  receiverLight: 'support.topic.receiverLight',
};

/** A translated "… {list}." cut before the list: its heading, in every language. */
const headingOf = (t: T, key: MessageKey) => t(key, { list: '\u0001' }).split('\u0001')[0]!.trim();

/** What the invitation says for a plan (DeviceUi.support). */
function copyFor(plan: SupportPlan, kind: LiveDevice['kind'], t: T): Copy {
  const gapItems = plan.gaps.map((g) => t(GAP[g]));
  const topicItems = (plan.unconfirmed ?? []).map((u) => t(TOPIC[u]));
  const list = gapItems.join(', ');
  const topics = topicItems.join(', ');
  const lists: Listed[] = [
    ...(gapItems.length ? [{ heading: headingOf(t, 'support.gaps'), items: gapItems }] : []),
    ...(topicItems.length
      ? [{ heading: headingOf(t, 'support.unconfirmed'), items: topicItems }]
      : []),
  ];
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
  // Nothing missing, but settings no recording of this model confirmed yet.
  if (!list) {
    return {
      title: 'support.title.complete',
      lists,
      action: 'support.action.confirm',
      strip: t(
        kind === 'keyboard'
          ? 'support.strip.unconfirmed.keyboard'
          : 'support.strip.unconfirmed.mouse',
        { list: topics },
      ),
      stripAction: 'support.strip.confirm',
    };
  }
  const steps = Array.isArray(plan.record) && plan.record.some((s) => s !== 'specific');
  return {
    title: 'support.title.complete',
    lists,
    action: steps ? 'support.action.steps' : 'support.action.specific',
    strip: t(kind === 'keyboard' ? 'support.strip.keyboard' : 'support.strip.mouse', { list }),
    stripAction: 'support.strip.add',
  };
}

/**
 * The invitation's buttons. On the desktop the main one starts the device
 * report tool for this device (main/reportTool.ts), set to what it lacks:
 * Windows records the official software, and so does Linux (the software in
 * a Windows virtual machine or Wine); macOS makes the report alone. Before a
 * tool that talks to the device, it says that Shark Deck closes, so the
 * official software is the only one talking to it. A demo device opens the
 * tool on the steps its owner would follow, recording nothing. The browser
 * edition cannot start a program: "How it works" is its one button. A tool
 * that would not start says why and opens the "Missing a device?" page.
 */
function Actions({ device, plan, copy }: { device: LiveDevice; plan: SupportPlan; copy: Copy }) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const os = useStore((s) => s.platformInfo?.os);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const demo = !!device.simulated;
  const records = plan.record !== 'report';
  // A demo device has steps to show only where a recording is asked for.
  const launch = hostFeatures.reportTool && (!demo || records);
  const recordsHere = os === 'win32' || os === 'linux';
  // Where nothing is recorded (a Mac: its body says so), the button makes the report alone.
  const reportOnly = launch && !demo && records && !recordsHere;
  const closesFirst = launch && !demo && (os === 'win32' || (os === 'linux' && records));
  const howto = () => void sd.openExternal(MISSING_DEVICE_URL);
  const run = async () => {
    setBusy(true);
    const r = await sd
      .openReportTool(device.id)
      .catch((e: unknown) => ({ ok: false, error: String(e), quitting: false, preview: false }));
    setBusy(false);
    setAsking(false);
    if (!r.ok) {
      toast('err', t('support.failed', { error: r.error ?? '' }));
      howto();
    } else if (r.preview) toast('info', t('support.preview'));
    else if (!r.quitting) toast('info', t('support.opened'));
  };
  const start = () => (closesFirst ? setAsking(true) : void run());
  // Asked in a dialog, not under the buttons: nothing moves under the pointer,
  // and the answer is a button of its own.
  const answer = (go: boolean) => {
    setAsking(false);
    if (go) void run();
  };
  return (
    <>
      {asking && (
        <ConfirmDialog
          title={t('support.confirm.title')}
          body={t('support.confirm')}
          confirmLabel={t('support.confirm.ok')}
          onResolve={answer}
        />
      )}
      {launch && !demo && records && os === 'linux' && (
        <p className="hint support-note">{t('support.linux')}</p>
      )}
      {!hostFeatures.reportTool && records && (
        <p className="hint support-note">{t('support.web')}</p>
      )}
      <div className="support-actions">
        <button className={launch ? 'btn' : 'btn primary'} onClick={howto}>
          {t('support.howto')}
        </button>
        {launch && (
          <button className="btn primary" disabled={busy || asking} onClick={start}>
            {busy ? t('support.starting') : t(reportOnly ? 'support.action.report' : copy.action)}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * The body for this computer. A Mac records nothing, so where a recording is
 * asked for, its body says what a Mac can do (the report) and where the
 * recording is made (a Windows or Linux computer). Windows, Linux and the
 * browser keep the plan's own body; Linux and the browser add a line of their
 * own under it (`Actions`).
 */
function bodyFor(plan: SupportPlan, copy: Copy, os: string | undefined): MessageKey | undefined {
  if (hostFeatures.reportTool && os === 'darwin' && plan.record !== 'report') {
    return 'support.body.mac';
  }
  return copy.body;
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
  const os = useStore((s) => s.platformInfo?.os);
  const plan = device.ui.support;
  if (!plan) return null;
  const copy = copyFor(plan, device.kind, t);
  const body = bodyFor(plan, copy, os);
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
        {body && <p className="hint">{t(body)}</p>}
        <Actions device={device} plan={plan} copy={copy} />
      </div>
    );
  }
  if (plan.level === 'none') return null;
  return (
    <Panel title={t(copy.title)} className="support-invite">
      {copy.lists?.map((l) => (
        <p className="support-lead" key={l.heading}>
          {l.heading}{' '}
          {l.items.map((item) => (
            <span className="support-item" key={item}>
              {item}
            </span>
          ))}
        </p>
      ))}
      {body && <p className="hint">{t(body)}</p>}
      <Actions device={device} plan={plan} copy={copy} />
    </Panel>
  );
}
