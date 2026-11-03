import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useT } from '../state/i18n';
import { Icon } from './icons';

/**
 * Catches an error in whatever it wraps — React routes both render-phase
 * throws and effect throws (useEffect/useLayoutEffect) in a boundary's
 * subtree to it — and shows a recoverable panel instead of letting the
 * error reach the root and unmount the *entire* app.
 *
 * Why this exists: the window is frameless (see main/index.ts) and its
 * titlebar (`WindowControls`, the Auto-Switch toggle, the language menu) is
 * ordinary React. Before this existed, ANY uncaught error anywhere —
 * including inside one of those topbar widgets, confirmed by deliberately
 * reproducing one during development — unmounted the whole tree with
 * nothing left to click, which is exactly what "black window, must kill the
 * process" looks like. `App.tsx` wraps each open tab's content individually
 * (so one broken tab doesn't take down the others) AND wraps the topbar's
 * own IO-touching widgets separately with a `fallback` that keeps the
 * window itself controllable even if the fancy chrome around it breaks.
 */
interface Props {
  children: ReactNode;
  /** shown in the default panel so the broken tab is identifiable, e.g. a device name */
  label?: string;
  /** replaces the default full panel — for a small topbar widget where a big
   *  "something went wrong" card would be worse than just disappearing (or
   *  falling back to a minimal safe control, see WindowControls in App.tsx) */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Pick<State, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // eslint-disable-next-line no-console
    console.error(
      'SharkDeck renderer error (caught by ErrorBoundary):',
      error,
      info.componentStack,
    );
  }

  private reset = () => this.setState({ error: null, componentStack: null, copied: false });

  private copy = () => {
    const { error, componentStack } = this.state;
    if (!error) return;
    const text = [error.message, componentStack ?? ''].filter(Boolean).join('\n\n');
    navigator.clipboard
      .writeText(text)
      .then(() => {
        this.setState({ copied: true });
        setTimeout(() => this.setState({ copied: false }), 1500);
      })
      .catch(() => undefined);
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <ErrorPanel
        error={error}
        label={this.props.label}
        copied={copied}
        onReset={this.reset}
        onCopy={this.copy}
      />
    );
  }
}

/**
 * The default panel, in the app's language. A function component of its own
 * because a class cannot call `useT()`; it reads nothing but context, so the
 * panel that reports a broken view cannot break the same way.
 */
function ErrorPanel({
  error,
  label,
  copied,
  onReset,
  onCopy,
}: {
  error: Error;
  label?: string;
  copied: boolean;
  onReset: () => void;
  onCopy: () => void;
}) {
  const t = useT();
  return (
    <div className="error-boundary">
      <div className="error-boundary-card">
        <h3>{label ? t('err.boundary.titleIn', { label }) : t('err.boundary.title')}</h3>
        <p className="hint">{t('err.boundary.body')}</p>
        <pre className="mono">{error.message}</pre>
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn primary" onClick={onReset}>
            {t('err.boundary.reload')}
          </button>
          <button className="btn icon-only" title={t('err.boundary.copy')} onClick={onCopy}>
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
