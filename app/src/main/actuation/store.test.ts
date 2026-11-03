import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KeyGroup } from '@shared/types/keyboard-settings';

let dir: string;
vi.mock('electron', () => ({ app: { getPath: () => dir, isPackaged: false } }));

const { ensureDirs } = await import('../store');
const {
  listKeyGroups,
  saveKeyGroup,
  deleteKeyGroup,
  replaceKeyGroups,
  listActuationLayouts,
  saveActuationLayout,
  deleteActuationLayout,
} = await import('./store');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sharkdeck-act-'));
  ensureDirs();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const group = (over: Partial<KeyGroup> = {}): KeyGroup => ({
  id: '',
  name: 'WASD',
  color: '#4cc9f0',
  slots: [9, 14, 15, 21],
  ...over,
});

describe('key groups', () => {
  it('mints an id and stores per model', async () => {
    const saved = await saveKeyGroup('r85he', 1, group());
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).not.toBe('');
    // Another model must not see it — `slots` are that board's matrix indices.
    expect(await listKeyGroups('other', 1)).toEqual([]);
    expect(await listKeyGroups('r85he', 1)).toHaveLength(1);
  });

  it('keeps each onboard profile to its own groups and names', async () => {
    // The reported bug: renaming a group on profile 1 renamed one on profile
    // 2, because both reconciled against one list per model.
    const [a] = await saveKeyGroup('r85he', 1, group({ name: 'WASD' }));
    await saveKeyGroup('r85he', 2, group({ name: 'Movement' }));
    await saveKeyGroup('r85he', 1, { ...a!, name: 'WASD renamed' });
    expect((await listKeyGroups('r85he', 1)).map((g) => g.name)).toEqual(['WASD renamed']);
    expect((await listKeyGroups('r85he', 2)).map((g) => g.name)).toEqual(['Movement']);
    // A replace on one profile leaves the other alone too.
    await replaceKeyGroups('r85he', 2, []);
    expect((await listKeyGroups('r85he', 1)).map((g) => g.name)).toEqual(['WASD renamed']);
  });

  it("reads a pre-per-profile file as every profile's starting point", async () => {
    // The old shape: one bare list per model. Each profile starts from it, so
    // nobody loses the names they saw, and the first write on a profile gives
    // that profile a list of its own without touching the others.
    await fs.mkdir(path.join(dir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'config', 'key-groups.json'),
      JSON.stringify({ r85he: [{ id: 'g1', name: 'Old', color: '#4cc9f0', slots: [9] }] }),
    );
    expect((await listKeyGroups('r85he', 1)).map((g) => g.name)).toEqual(['Old']);
    expect((await listKeyGroups('r85he', 3)).map((g) => g.name)).toEqual(['Old']);
    await saveKeyGroup('r85he', 3, { id: 'g1', name: 'New', color: '#4cc9f0', slots: [9] });
    expect((await listKeyGroups('r85he', 3)).map((g) => g.name)).toEqual(['New']);
    expect((await listKeyGroups('r85he', 1)).map((g) => g.name)).toEqual(['Old']);
  });

  it('takes a key off every other group when one claims it', async () => {
    // The colour on the board says "this key is in that group", singular. Two
    // groups holding the same slot would make that a lie, and the renderer
    // would paint whichever it happened to iterate last.
    const [first] = await saveKeyGroup('r85he', 1, group({ name: 'WASD', slots: [9, 14, 15, 21] }));
    const after = await saveKeyGroup(
      'r85he',
      1,
      group({ name: 'Arrows', color: '#f7b32b', slots: [21, 40, 41] }),
    );
    expect(after.find((g) => g.id === first!.id)!.slots).toEqual([9, 14, 15]);
    expect(after.find((g) => g.name === 'Arrows')!.slots).toEqual([21, 40, 41]);
  });

  it('upserts in place rather than moving an edited group to the end', async () => {
    const [a] = await saveKeyGroup('r85he', 1, group({ name: 'A', slots: [1] }));
    await saveKeyGroup('r85he', 1, group({ name: 'B', color: '#8ac926', slots: [2] }));
    const after = await saveKeyGroup('r85he', 1, { ...a!, name: 'A renamed' });
    expect(after.map((g) => g.name)).toEqual(['A renamed', 'B']);
  });

  it('deletes only the named group, only for that model', async () => {
    const [a] = await saveKeyGroup('r85he', 1, group({ name: 'A', slots: [1] }));
    await saveKeyGroup('v8', 1, group({ name: 'mouse group', slots: [1] }));
    expect(await deleteKeyGroup('r85he', 1, a!.id)).toEqual([]);
    expect(await listKeyGroups('v8', 1)).toHaveLength(1);
  });
});

describe('saved actuation layouts', () => {
  it('mints an id and a createdAt, and upserts in place', async () => {
    const saved = await saveActuationLayout({
      id: '',
      name: 'Tournament',
      createdAt: 0,
      model: 'r85he',
      keys: [],
      groups: [],
    });
    expect(saved[0]!.id).not.toBe('');
    expect(saved[0]!.createdAt).toBeGreaterThan(0);

    const renamed = await saveActuationLayout({ ...saved[0]!, name: 'Tournament v2' });
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.name).toBe('Tournament v2');
    expect(renamed[0]!.createdAt).toBe(saved[0]!.createdAt);
  });

  it('deletes by id', async () => {
    const saved = await saveActuationLayout({
      id: '',
      name: 'X',
      createdAt: 0,
      keys: [],
      groups: [],
    });
    expect(await deleteActuationLayout(saved[0]!.id)).toEqual([]);
    expect(await listActuationLayouts()).toEqual([]);
  });
});
