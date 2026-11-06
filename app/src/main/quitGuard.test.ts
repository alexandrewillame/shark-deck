import { afterEach, describe, expect, it } from 'vitest';
import { allowQuit, resetQuitGuard, setPendingChanges, shouldAskBeforeQuit } from './quitGuard';

/** When index.ts holds a quit for the renderer's prompt (see quitGuard.ts). */
describe('quitGuard', () => {
  afterEach(() => resetQuitGuard());

  it('lets a quit through when nothing is pending', () => {
    expect(shouldAskBeforeQuit()).toBe(false);
  });

  it('holds a quit while the renderer reports a change nobody applied', () => {
    setPendingChanges(true);
    expect(shouldAskBeforeQuit()).toBe(true);
  });

  it('stops holding once the renderer holds nothing — applied, discarded or reloaded', () => {
    setPendingChanges(true);
    setPendingChanges(false);
    expect(shouldAskBeforeQuit()).toBe(false);
  });

  it('lets the quit through once the user has answered the prompt', () => {
    setPendingChanges(true);
    allowQuit();
    expect(shouldAskBeforeQuit()).toBe(false);
  });
});
