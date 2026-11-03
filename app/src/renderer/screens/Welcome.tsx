import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import type { ScanDiagnostic } from '@shared/types/diagnostics';

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

function Diagnostic({ diag }: { diag: ScanDiagnostic }) {
  const t = useT();
  const REASON_KEY: Record<
    ScanDiagnostic['unmatched'][number]['reason'],
    | 'welcome.reason.unknownModel'
    | 'welcome.reason.noVendorCollection'
    | 'welcome.reason.permissionDenied'
  > = {
    'unknown-model': 'welcome.reason.unknownModel',
    'no-vendor-collection': 'welcome.reason.noVendorCollection',
    // Rare here — most permission failures resolve to a device first and
    // only fail once opened (see LiveDevice.hint / hint.offlinePermission),
    // but a hardened kernel can also block reading the report descriptor
    // itself, which fails matching before a device object ever exists.
    'permission-denied': 'welcome.reason.permissionDenied',
  };

  if (diag.lastError) {
    // node-hid's Linux binding links libusb, so where it is missing nothing
    // can be enumerated — and reconnecting or restarting will not change that.
    const missingLibusb = /libusb-1\.0\.so/.test(diag.lastError);
    return (
      <div className="scan-diag err">
        {t('welcome.scanFailed', { error: diag.lastError })}
        <div className="scan-diag-sub">
          {t(missingLibusb ? 'welcome.scanFailedLibusb' : 'welcome.scanFailedHint')}
        </div>
      </div>
    );
  }

  if (diag.vendorMatches > 0 && diag.resolved === 0 && diag.unmatched.length > 0) {
    return (
      <div className="scan-diag warn">
        {t('welcome.foundUnopenable')}
        <ul>
          {diag.unmatched.map((u) => (
            <li key={`${u.vid}:${u.pid}`}>
              <span className="mono">
                {hex4(u.vid)}:{hex4(u.pid)}
              </span>
              {u.product ? ` “${u.product}” ` : ' '}— {t(REASON_KEY[u.reason])}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (diag.totalCollections > 0) {
    return (
      <div className="scan-diag">
        {t(diag.totalCollections === 1 ? 'welcome.scanned.one' : 'welcome.scanned.many', {
          n: diag.totalCollections,
        })}
      </div>
    );
  }

  return null;
}

export function Welcome() {
  const diag = useStore((s) => s.scanDiag);
  const t = useT();

  return (
    <div className="welcome">
      <div className="inner">
        <svg className="receiver-anim" viewBox="0 0 200 200" fill="none">
          <circle className="pulse" cx="100" cy="100" r="70" fill="var(--accent)" opacity="0.15" />
          <circle
            className="pulse"
            cx="100"
            cy="100"
            r="46"
            fill="var(--violet)"
            opacity="0.15"
            style={{ animationDelay: '0.6s' }}
          />
          <rect
            x="78"
            y="60"
            width="44"
            height="80"
            rx="10"
            fill="var(--bg-2)"
            stroke="url(#wg)"
            strokeWidth="2"
          />
          <rect x="92" y="46" width="16" height="18" rx="3" fill="var(--bg-3)" />
          <circle cx="100" cy="118" r="6" fill="var(--accent)">
            <animate
              attributeName="opacity"
              values="0.3;1;0.3"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </circle>
          <defs>
            <linearGradient id="wg" x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="var(--accent)" />
              <stop offset="1" stopColor="var(--violet)" />
            </linearGradient>
          </defs>
        </svg>
        <h1>{t('welcome.title')}</h1>
        <p>{t('welcome.body')}</p>
        <div className="scanning">
          <span className="dot-scan" />
          {t('welcome.scanning')}
        </div>
        {diag && <Diagnostic diag={diag} />}
      </div>
    </div>
  );
}
