import { useEffect, useRef, useState } from 'react';
import type { KeyLayoutEntry } from '@shared/types/keys';
import type { PerKeyColor, PerKeyLightingPreset } from '@shared/types/lighting';
import { KB_LIGHT_STEPS } from '@shared/lighting';
import { Panel, Row, StepSlider, Tooltip } from '../../components/common';
import { Icon, type IconName } from '../../components/icons';
import { ColorPickerField } from '../../components/ColorPickerField';
import { KeyboardMap } from '../../components/KeyboardMap';
import { InfoLabel } from '../../components/InfoLabel';
import { SavedLibraryPanel } from '../../components/SavedLibraryPanel';
import { type TabProps, sd, useDeviceData, useDeviceBusy, useWrite } from '../common';
import { useT } from '../../state/i18n';
import { useStore } from '../../state/store';
import { modKeyLabel, useIsMac } from '../../state/shortcuts';
import { hexToRgb, rgbToHex } from '../../colorUtil';
import { slotOf } from '../../keyLayout';
import { previewRgbCss } from './effectPreview';
import { LightStage } from './LightStage';
import { PanelActions } from './PanelActions';
import { asKeys, toColorMap, withKey, type PerKeyEditor } from './usePerKeyEditor';
import { usePerKeyShortcuts } from './usePerKeyShortcuts';

type Tool = 'brush' | 'pick' | 'rect';

/**
 * The per-key editor: a board you paint, the tools beside it, and the saved
 * layouts below.
 *
 * Nothing touches the keyboard until Apply. Painting, Clear all, Fill all and
 * Load are all editor-only and all undoable (Ctrl+Z, 40 steps); Cancel goes
 * back to what the board was last read or applied as — undoably too.
 *
 * The editor's state lives in MainLightingPane (`editor`), not here, so a trip
 * to Global and back keeps both the picture and its history.
 */
export function PerKeyPane({
  device,
  editor,
  showing,
  onApplied,
}: TabProps & {
  editor: PerKeyEditor;
  /** A successful write: the board's main effect is now the per-key layer at
   *  this brightness. */
  onApplied: (brightness: number) => void;
  /** The keyboard is lighting its per-key picture right now — false while it
   *  runs a Global effect, when the picture is stored but not shown. */
  showing: boolean;
}) {
  const t = useT();
  const layout = device.ui.keyMatrix?.layout;
  const { history, colors, paint, setPaint, brightness } = editor;
  const {
    data: loaded,
    firstLoad,
    reload,
  } = useDeviceData<PerKeyColor[] | null>(
    device.id,
    sd.readPerKeyLighting,
    [],
    [],
    'perKeyLighting',
  );
  const toast = useStore((s) => s.toast);
  const { run } = useWrite();
  const { whileBusy } = useDeviceBusy(device.id);
  const [applying, setApplying] = useState(false);
  const [tool, setTool] = useState<Tool>('brush');
  /** Shift or Ctrl held: the board shows the box cursor (the gesture itself is
   *  read off each press — see KeyboardMap's `marqueeOnModifier`). */
  const [modHeld, setModHeld] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);

  /**
   * A read landing in the editor. A read the user asked for (Read from
   * keyboard, or a saved layout's Apply) is an undoable step; a quiet one —
   * the cached read on mount, the check after an Apply — only replaces a
   * picture with no unapplied changes in it.
   */
  const explicitRead = useRef(false);
  /** Read from keyboard was pressed: its outcome is said out loud. It used to
   *  land silently — a read that matched the board looked like nothing
   *  happening, and one with no answer blanked the board. */
  const announceRead = useRef(false);
  const { adopt, commit, seal, undo, redo } = history;
  useEffect(() => {
    if (firstLoad && loaded?.length === 0) return; // the placeholder, not a read
    const explicit = explicitRead.current;
    const announce = announceRead.current;
    explicitRead.current = false;
    announceRead.current = false;
    // No answer: the board keeps what it shows. (A quiet read that failed is
    // the Re-read banner's business; one the user asked for says so here.)
    if (loaded === null) {
      if (announce) toast('warn', t('light.perkey.read.failed'));
      return;
    }
    const map = toColorMap(loaded);
    adopt(map, explicit);
    if (announce) {
      const n = Object.keys(map).length;
      toast(
        'info',
        n ? t('light.perkey.read.done', { n: String(n) }) : t('light.perkey.read.empty'),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, firstLoad, adopt]);

  // A paint stroke is ONE undo step however many keys it crosses: commits
  // coalesce under 'paint' until the press ends, anywhere on screen.
  const pickedThisPress = useRef(false);
  useEffect(() => {
    const end = () => {
      seal();
      pickedThisPress.current = false;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
    };
  }, [seal]);

  usePerKeyShortcuts({
    probeRef: boardRef,
    onTool: setTool,
    onEscape: () => {
      if (tool === 'brush') return false;
      setTool('brush');
      return true;
    },
    onUndo: undo,
    onRedo: redo,
    onModifierHeld: setModHeld,
  });

  const readBoard = () => {
    explicitRead.current = true;
    announceRead.current = true;
    editor.resetBrightness();
    reload();
  };

  const apply = async () => {
    setApplying(true);
    const sent = colors;
    const b = brightness;
    // Seven chunked colour frames — by far the slowest thing this tab does.
    await whileBusy(t('busy.lighting'), async () => {
      const r = await run(t('light.apply'), () =>
        sd.setPerKeyLighting(device.id, asKeys(sent), { brightness: b }),
      );
      if (r.ok) {
        history.markSaved(sent);
        onApplied(b);
      }
    });
    setApplying(false);
    // Read back rather than trust the write — quietly: it is not a change the
    // user made, so it is no undo step.
    reload();
  };

  const fillAll = () => {
    if (!layout) return;
    const c = hexToRgb(paint);
    commit(Object.fromEntries(layout.map((k, i) => [k.slot ?? i, c])));
  };

  const [presets, setPresets] = useState<PerKeyLightingPreset[]>([]);
  useEffect(() => {
    sd.listPerKeyLightingLibrary().then(setPresets);
  }, []);

  const mod = modKeyLabel();
  // ⌘Y works too, but ⇧⌘Z is what a Mac calls redo — and Ctrl-click is a
  // right-click there, so the box tip names ⌘ instead.
  const isMac = useIsMac();
  const boxCursor = tool === 'rect' || (tool === 'brush' && modHeld);

  return (
    <>
      <LightStage
        boardRef={boardRef}
        tools={
          <div
            className="light-tools"
            role="toolbar"
            aria-orientation="vertical"
            aria-label={t('light.perkey.tools')}
          >
            <Tooltip text={t('light.perkey.brush.tip')}>
              <ColorPickerField
                variant="tool"
                align="end"
                className="light-tool"
                value={paint}
                onChange={setPaint}
                ariaLabel={t('light.perkey.brush')}
              />
            </Tooltip>
            <ToolButton
              icon="pipette"
              on={tool === 'pick'}
              label={t('light.perkey.pick')}
              tip={t('light.perkey.pick.tip', { key: 'I' })}
              shortcut="I"
              onClick={() => setTool((v) => (v === 'pick' ? 'brush' : 'pick'))}
            />
            <ToolButton
              icon="marquee"
              on={tool === 'rect'}
              label={t('light.perkey.rect')}
              tip={t(isMac ? 'light.perkey.box.tip.mac' : 'light.perkey.box.tip', { key: 'M' })}
              shortcut="M"
              onClick={() => setTool((v) => (v === 'rect' ? 'brush' : 'rect'))}
            />
            <span className="light-tools-sep" aria-hidden="true" />
            <ToolButton
              icon="undo"
              label={t('common.undo')}
              tip={t('common.undo.tip', { keys: `${mod}Z` })}
              disabled={!history.canUndo}
              onClick={undo}
            />
            <ToolButton
              icon="redo"
              label={t('common.redo')}
              tip={t('common.redo.tip', { keys: isMac ? '⇧⌘Z' : `${mod}Y` })}
              disabled={!history.canRedo}
              onClick={redo}
            />
          </div>
        }
      >
        <div className={tool === 'pick' ? 'kbmap-picking' : boxCursor ? 'kbmap-boxing' : undefined}>
          <KeyboardMap
            ref={boardRef}
            layout={layout}
            // This board IS the lighting: the caps go dark and painted keys
            // get the backlit treatment, same as the Global preview — down to
            // the slight unsteadiness of real LEDs.
            lit
            flicker
            // Box fill rather than box SELECT: this pane paints, it has no
            // selection to make. The box tool, or Shift/Ctrl + drag while
            // painting; every key the box touches takes the brush colour.
            marqueeOnModifier
            marqueeFromKeys={tool === 'rect'}
            onMarquee={(keys) => {
              const c = hexToRgb(paint);
              commit((cur) => {
                let next = cur;
                for (const k of keys) {
                  const slot = slotOf(layout, k);
                  if (slot !== null) next = withKey(next, slot, c);
                }
                return next;
              });
            }}
            onPaint={(k) => {
              if (tool === 'rect' || pickedThisPress.current) return;
              const slot = slotOf(layout, k);
              if (slot === null) return;
              if (tool === 'pick') {
                // The colour the key HOLDS, never the dimmed one on screen.
                setPaint(rgbToHex(colors[slot] ?? [0, 0, 0]));
                setTool('brush');
                // The rest of this press is not a paint stroke.
                pickedThisPress.current = true;
                return;
              }
              commit((cur) => withKey(cur, slot, hexToRgb(paint)), 'paint');
            }}
            accent={(k) => {
              const slot = slotOf(layout, k);
              const c = slot !== null ? colors[slot] : undefined;
              // Shown at the brightness the board will run it at — display
              // only; what is written is the colour itself.
              return c ? previewRgbCss(c, brightness) : undefined;
            }}
          />
        </div>
      </LightStage>

      <Panel title={t('light.perkey.title')}>
        {/* Everything that acts on the whole board, on one line: the two
            editor-only fills, then the device's own Read / Apply, and Cancel. */}
        <Row
          label={t('light.perkey.board')}
          className="perkey-board-row"
          // The picture here is the keyboard's stored one, which it only
          // lights while on its per-key layer — otherwise the board and the
          // keys in front of you disagree, with nothing saying why.
          hint={showing ? undefined : t('light.perkey.notShowing')}
        >
          <Tooltip text={t('light.perkey.clear.tip')}>
            <button className="btn" onClick={() => commit({})}>
              <Icon name="close" size={12} /> {t('light.perkey.clearAll')}
            </button>
          </Tooltip>
          <Tooltip text={t('light.perkey.fillAll.tip')}>
            <button className="btn" onClick={fillAll}>
              <Icon name="palette" size={12} /> {t('light.perkey.fillAll')}
            </button>
          </Tooltip>
          <span className="perkey-board-sep" aria-hidden="true" />
          <PanelActions
            dirty={editor.dirty}
            busy={applying}
            onApply={apply}
            onRead={readBoard}
            onCancel={editor.cancel}
            cancelTip={t('light.perkey.cancel.tip')}
          />
        </Row>
        <Row
          label={
            <InfoLabel label={t('common.brightness')} text={t('light.perkey.brightness.tip')} />
          }
        >
          <StepSlider
            value={brightness}
            steps={KB_LIGHT_STEPS}
            ariaLabel={t('common.brightness')}
            onChange={editor.setBrightness}
          />
        </Row>
      </Panel>

      <SavedLibraryPanel
        title={t('light.perkey.library')}
        tip={t('light.perkey.library.tip')}
        entries={presets}
        emptyText={t('light.perkey.noPresets')}
        replaceTitle={(name) => t('light.perkey.replace', { name })}
        replaceBody={t('light.perkey.replace.body')}
        renameLabel={t('light.perkey.rename')}
        onSave={async (id, name) =>
          setPresets(
            await sd.savePerKeyLightingLibraryEntry({
              id,
              name,
              createdAt: 0,
              model: device.model,
              colors: asKeys(colors),
            }),
          )
        }
        onRename={async (p, name) =>
          setPresets(await sd.savePerKeyLightingLibraryEntry({ ...p, name }))
        }
        thumb={(p, u) => <PresetBoard layout={layout} colors={p.colors} u={u} />}
        hint={(p) =>
          p.model && p.model !== device.model ? t('light.perkey.otherModel') : undefined
        }
        actions={(p) => (
          <>
            <Tooltip text={t('light.perkey.load.tip')}>
              {/* Editor only, and undoable — Apply to keyboard is what
                  reaches the board. */}
              <button className="btn" onClick={() => commit(toColorMap(p.colors))}>
                <Icon name="folder" size={12} /> {t('light.perkey.load')}
              </button>
            </Tooltip>
            <Tooltip text={t('light.perkey.applyBtn.tip')}>
              <button
                className="btn"
                onClick={async () => {
                  // Through `run`, like every device write: a refused backup
                  // or a missing preset surfaces as a toast. Same brightness
                  // the editor's own Apply sends — a saved layout stores
                  // colours only.
                  const r = await run(t('light.apply'), () =>
                    sd.applyPerKeyLightingLibraryEntry(device.id, p.id, brightness),
                  );
                  if (r.ok) onApplied(brightness);
                  // The editor then shows what the board now holds — as an
                  // undoable step, since it replaces whatever was on it.
                  explicitRead.current = true;
                  reload();
                }}
              >
                <Icon name="upload" size={12} /> {t('light.apply')}
              </button>
            </Tooltip>
            <Tooltip text={t('light.perkey.delete.tip')}>
              <button
                className="btn icon-only"
                onClick={async () => setPresets(await sd.deletePerKeyLightingLibraryEntry(p.id))}
                aria-label={t('common.delete')}
              >
                <Icon name="trash" size={12} />
              </button>
            </Tooltip>
          </>
        )}
      />
    </>
  );
}

/** One tool in the column: an icon button the size of the brush chip. */
function ToolButton({
  icon,
  label,
  tip,
  onClick,
  on,
  disabled,
  shortcut,
}: {
  icon: IconName;
  label: string;
  tip: string;
  onClick: () => void;
  on?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <Tooltip text={tip}>
      <button
        className={`btn icon-only light-tool ${on ? 'primary' : ''}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={on === undefined ? undefined : on}
        aria-keyshortcuts={shortcut}
      >
        <Icon name={icon} size={13} />
      </button>
    </Tooltip>
  );
}

/**
 * A saved layout, drawn as the board it is — the same component at u=5 is the
 * row thumbnail and at u=14 the hover preview, so the two cannot disagree.
 *
 * `u` goes through KeyboardMap's own `keyU` prop. It used to be set as a CSS
 * variable on this wrapper, which never took effect: KeyboardMap sets
 * `--kb-u` inline on the board element itself, and that wins over an
 * inherited value.
 */
export function PresetBoard({
  layout,
  colors,
  u,
}: {
  layout?: KeyLayoutEntry[];
  colors: PerKeyColor[];
  u: number;
}) {
  const bySlot = new Map(colors.map((c) => [c.index, c.color] as const));
  return (
    <span className="preset-board">
      <KeyboardMap
        layout={layout}
        interactive={false}
        fit={false}
        bare
        keyU={u}
        showLabels={false}
        // A thumbnail of a lighting preset is a picture of a lit board. Every
        // glow length is relative to `--kb-u`, so at this size it comes out as
        // a soft bloom rather than a scaled-up halo.
        lit
        accent={(k) => {
          const c = bySlot.get(k.slot ?? -1);
          return c ? `rgb(${c[0]},${c[1]},${c[2]})` : undefined;
        }}
      />
    </span>
  );
}
