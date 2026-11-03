/**
 * Drag payload types used inside the macro editor.
 *
 * Both are read from `dataTransfer.types` during `dragover` — the *data* itself
 * is unreadable until drop for security reasons, but the type list is not, and
 * that is all an insert point needs to know to decide whether it is a valid
 * target and which highlight to show. Custom types (rather than `text/plain`)
 * so dragging a step over the list can never be confused with text dropped in
 * from outside the app.
 */
export const DRAG_STEP = 'application/x-sharkdeck-macro-step';
export const DRAG_TAKE = 'application/x-sharkdeck-macro-take';

export const dragHas = (dt: DataTransfer, type: string): boolean =>
  Array.from(dt.types).includes(type);
