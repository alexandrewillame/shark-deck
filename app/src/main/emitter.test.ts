import { describe, expect, it } from 'vitest';
import { Emitter } from './emitter';

describe('Emitter (the node:events subset the device layer uses)', () => {
  it('calls listeners in registration order with every argument', () => {
    const e = new Emitter();
    const calls: unknown[][] = [];
    e.on('changed', (...a) => calls.push(['first', ...a]));
    e.on('changed', (...a) => calls.push(['second', ...a]));
    expect(e.emit('changed', { a: 1 }, 'patch')).toBe(true);
    expect(calls).toEqual([
      ['first', { a: 1 }, 'patch'],
      ['second', { a: 1 }, 'patch'],
    ]);
  });

  it('reports whether anyone listened, and removes listeners', () => {
    const e = new Emitter();
    const fn = () => {};
    expect(e.emit('x')).toBe(false);
    e.on('x', fn);
    expect(e.listenerCount('x')).toBe(1);
    e.off('x', fn);
    expect(e.listenerCount('x')).toBe(0);
    expect(e.emit('x')).toBe(false);
  });

  it('does not run a listener added during the emit that added it', () => {
    const e = new Emitter();
    let late = 0;
    e.on('x', () => e.on('x', () => late++));
    e.emit('x');
    expect(late).toBe(0);
    e.emit('x');
    expect(late).toBe(1);
  });
});
