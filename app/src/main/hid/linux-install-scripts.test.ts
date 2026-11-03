import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The .deb/.rpm install hooks (scripts/linux/after-install.sh,
 * after-remove.sh), as electron-builder will process them.
 *
 * A hook given in electron-builder.yml REPLACES electron-builder's own
 * after-install template rather than adding to it, and that template is what
 * makes the app start on Ubuntu 24.04+ (the AppArmor profile, chrome-sandbox's
 * mode). Ours carry it — these keep them carrying it, and keep them buildable:
 * electron-builder substitutes every dollar-brace name in the file, comments
 * included, and fails the whole Linux build on one it doesn't define.
 */
const SCRIPTS = join(__dirname, '../../../scripts/linux');
const read = (name: string) => readFileSync(join(SCRIPTS, name), 'utf8');

/** What FpmTarget's writeConfigFile defines for these scripts (plus the
 *  linux config's own keys, none of which a script has any use for). */
const MACROS = new Set(['executable', 'sanitizedProductName', 'productFilename']);

describe.each(['after-install.sh', 'after-remove.sh'])('%s', (name) => {
  const text = read(name);

  it('uses only macros electron-builder defines', () => {
    // The same pattern electron-builder replaces with.
    const used = [...text.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]!);
    expect(used.filter((m) => !MACROS.has(m))).toEqual([]);
  });

  it('is LF-only, as /bin/bash needs', () => {
    expect(text.includes('\r')).toBe(false);
    expect(text.startsWith('#!/bin/bash\n')).toBe(true);
  });
});

describe('after-install.sh', () => {
  const text = read('after-install.sh');

  it("still does what electron-builder's own post-install did", () => {
    expect(text).toContain("'/opt/${sanitizedProductName}/resources/apparmor-profile'");
    expect(text).toContain("'/etc/apparmor.d/${executable}'");
    expect(text).toContain("chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'");
    expect(text).toContain("update-alternatives --install '/usr/bin/${executable}'");
  });

  it('installs the udev rule from where extraResources puts it', () => {
    expect(text).toContain("'/opt/${sanitizedProductName}/resources/udev/60-sharkdeck.rules'");
  });
});

describe('package dependencies (electron-builder.yml)', () => {
  // Without libusb node-hid does not load, and the app finds no device at
  // all; without ALSA Electron does not start. A `depends` list replaces
  // electron-builder's default, so these are only there if listed.
  const yml = readFileSync(join(__dirname, '../../../electron-builder.yml'), 'utf8');
  const depends = (target: string) => {
    const block = new RegExp(`^${target}:\\n((?:[ #].*\\n|\\n)*)`, 'm').exec(yml)?.[1] ?? '';
    return [...block.matchAll(/^ {4}- (.+)$/gm)].map((m) => m[1]!.trim());
  };

  it('the .deb declares libusb and ALSA, and keeps the default list', () => {
    expect(depends('deb')).toEqual(
      expect.arrayContaining(['libusb-1.0-0', 'libasound2', 'libgtk-3-0', 'libnss3']),
    );
  });

  it('the .rpm declares them by library', () => {
    expect(depends('rpm')).toEqual(
      expect.arrayContaining([
        'libusb-1.0.so.0()(64bit)',
        'libasound.so.2()(64bit)',
        'gtk3',
        'nss',
      ]),
    );
  });
});

describe('the Linux icon set (electron-builder.yml linux.icon)', () => {
  // electron-builder installs each file as hicolor/<NxN>/apps/sharkdeck.png,
  // and a desktop only looks in the size directories its theme defines.
  const HICOLOR = [16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512];
  const dir = join(__dirname, '../../../build/icons');
  const yml = readFileSync(join(__dirname, '../../../electron-builder.yml'), 'utf8');

  it('is the directory the linux config points at', () => {
    expect(yml).toMatch(/^linux:\n(?:[ #].*\n)*? {2}icon: build\/icons$/m);
  });

  it('holds only hicolor sizes, each the size its name says', () => {
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const m = /^(\d+)x(\d+)\.png$/.exec(f);
      expect(m, f).not.toBeNull();
      const n = Number(m![1]);
      expect(Number(m![2]), f).toBe(n);
      expect(HICOLOR, f).toContain(n);
      // PNG IHDR: width and height, big-endian, at bytes 16 and 20.
      const png = readFileSync(join(dir, f));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], f).toEqual([n, n]);
    }
  });
});

describe('after-remove.sh', () => {
  it('does nothing on an upgrade', () => {
    // The guard must come before anything that removes: rpm runs this as
    // %postun AFTER the new version's %post, with $1 = 1.
    const text = read('after-remove.sh');
    const guard = text.indexOf('case "$1" in');
    expect(guard).toBeGreaterThan(-1);
    expect(text.indexOf('rm -f')).toBeGreaterThan(guard);
    expect(text.indexOf('update-alternatives --remove')).toBeGreaterThan(guard);
    expect(text.indexOf('find ')).toBeGreaterThan(guard);
    expect(text).toMatch(/0\|remove\|purge\) ;;\s+\*\) exit 0 ;;/);
  });

  it('clears what rpm leaves in /opt, and only empty directories', () => {
    const text = read('after-remove.sh');
    const finds = text.split('\n').filter((l) => /^\s*find /.test(l));
    expect(finds).toHaveLength(1);
    expect(finds[0]).toContain("find '/opt/${sanitizedProductName}' -depth -type d -empty -delete");
  });
});

describe('after-install.sh under /bin/sh', () => {
  // rpm runs scriptlets with /bin/sh whatever their first line says.
  it('uses no bash-only test syntax', () => {
    expect(read('after-install.sh')).not.toMatch(/^[^#]*\[\[/m);
  });
});
