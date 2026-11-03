/**
 * Mouse-angle-mode illustration — a fixed crosshair (the "true" forward
 * direction) with a mouse silhouette rotated by `degrees` around its own
 * centre, so moving the slider visibly tilts the mouse away from the cross
 * the way Attack Shark's own Mouse Hub shows this setting.
 *
 * The swept wedge between the reference direction and the rotated one is
 * filled with a translucent accent tint, and the mouse body uses `--text`
 * for its outline rather than the accent colour, so the shape itself reads
 * clearly against both the light and dark surface — the previous all-accent
 * rendering washed out against a light-mode `--bg-3`.
 *
 * The silhouette body is semi-transparent so the fixed crosshair stays
 * visible *through* it — you can read the rotated centre-line against the
 * "true forward" dashed line even when the mouse sits right on top of it.
 */
export function AngleIllustration({ degrees }: { degrees: number }) {
  const cx = 60;
  const cy = 60;
  const r = 38;
  const rad = (degrees * Math.PI) / 180;
  const x1 = cx + r * Math.sin(rad);
  const y1 = cy - r * Math.cos(rad);
  const sweepFlag = degrees >= 0 ? 1 : 0;
  const wedgePath = `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 0 ${sweepFlag} ${x1} ${y1} Z`;

  return (
    <svg viewBox="0 0 120 120" width="160" height="160" fill="none">
      {/* fixed reference crosshair — "true" forward */}
      <line
        x1="60"
        y1="8"
        x2="60"
        y2="112"
        stroke="var(--text-mut)"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <line
        x1="8"
        y1="60"
        x2="112"
        y2="60"
        stroke="var(--text-mut)"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      {/* swept angle between the reference and the rotated direction */}
      {degrees !== 0 && <path d={wedgePath} fill="rgba(var(--accent-rgb), 0.18)" />}
      <g
        transform={`rotate(${degrees} 60 60)`}
        style={{ transition: 'transform var(--dur-med) var(--ease-out)' }}
      >
        <path
          d="M60 20c10 0 16.5 6 18.5 16 1.8 8.5 2.8 16.5 1.8 25.5C79.2 75.8 71 85 60 85c-11 0-19.2-9.2-20.3-23.5-1-9-0-17 1.8-25.5C43.5 26 50 20 60 20Z"
          fill="var(--bg-2)"
          fillOpacity="0.4"
          stroke="var(--text)"
          strokeWidth="2"
        />
        <path
          d="M60 22v30"
          stroke="var(--accent)"
          strokeWidth="1.6"
          style={{ filter: 'drop-shadow(0 0 3px rgba(var(--accent-rgb), 0.6))' }}
        />
        <circle cx="60" cy="60" r="2.6" fill="var(--accent)" />
      </g>
    </svg>
  );
}
