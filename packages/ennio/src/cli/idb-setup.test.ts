import { describe, it, expect, vi } from 'vitest';

import { ensureIdb, planInstall, type IdbDeps } from './idb-setup';

function makeDeps(over: Partial<IdbDeps> = {}): IdbDeps {
  return {
    platform: 'darwin',
    isTTY: true,
    env: {},
    onPath: () => true,
    brewAvailable: () => true,
    pipxAvailable: () => true,
    runInstall: vi.fn(),
    confirm: vi.fn(async () => true),
    log: vi.fn(),
    ...over,
  };
}

/** onPath that reports a given set of binaries as present. */
function pathWith(present: string[]) {
  return (bin: string) => present.includes(bin);
}

describe('planInstall', () => {
  it('plans only what is missing', () => {
    expect(planInstall({ companion: true, cli: true }, true)).toEqual([]);
    expect(planInstall({ companion: false, cli: true }, true).map((s) => s.label)).toEqual([
      'idb_companion (Homebrew)',
    ]);
  });

  it('prefers pipx, falls back to pip for the CLI', () => {
    expect(planInstall({ companion: true, cli: false }, true)[0].cmd).toBe('pipx');
    const pip = planInstall({ companion: true, cli: false }, false)[0];
    expect(pip.cmd).toBe('python3');
    expect(pip.args).toContain('fb-idb');
  });
});

describe('ensureIdb', () => {
  it('is a no-op when both binaries are present', async () => {
    const runInstall = vi.fn();
    const confirm = vi.fn(async () => true);
    await ensureIdb(makeDeps({ onPath: () => true, runInstall, confirm }));
    expect(runInstall).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('prompts then installs the missing binary on an interactive TTY', async () => {
    let present = ['idb']; // companion missing
    const runInstall = vi.fn(() => {
      present = ['idb', 'idb_companion']; // install makes it appear on PATH
    });
    const confirm = vi.fn(async () => true);
    const deps = makeDeps({ isTTY: true, onPath: (b) => present.includes(b), runInstall, confirm });
    await ensureIdb(deps);
    expect(confirm).toHaveBeenCalledOnce();
    expect(runInstall).toHaveBeenCalledOnce();
  });

  it('installs without prompting when ENNIO_AUTO_INSTALL_IDB is set', async () => {
    let present: string[] = [];
    const runInstall = vi.fn(() => {
      present = ['idb', 'idb_companion'];
    });
    const confirm = vi.fn(async () => true);
    await ensureIdb(
      makeDeps({
        env: { ENNIO_AUTO_INSTALL_IDB: '1' },
        onPath: (b) => present.includes(b),
        runInstall,
        confirm,
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(runInstall).toHaveBeenCalledTimes(2); // companion + cli
  });

  it('does NOT install on a non-TTY (CI) — throws with manual recipe', async () => {
    const runInstall = vi.fn();
    await expect(
      ensureIdb(makeDeps({ isTTY: false, onPath: pathWith([]), runInstall })),
    ).rejects.toThrow(/brew install/);
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('throws when the user declines', async () => {
    const runInstall = vi.fn();
    await expect(
      ensureIdb(makeDeps({ onPath: pathWith([]), confirm: async () => false, runInstall })),
    ).rejects.toThrow(/declined/);
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('throws when companion is missing and Homebrew is unavailable', async () => {
    await expect(
      ensureIdb(makeDeps({ onPath: pathWith(['idb']), brewAvailable: () => false })),
    ).rejects.toThrow(/Homebrew/);
  });

  it('throws if binaries still missing after a "successful" install', async () => {
    const runInstall = vi.fn(); // pretends to succeed but PATH never updates
    await expect(
      ensureIdb(makeDeps({ env: { ENNIO_AUTO_INSTALL_IDB: '1' }, onPath: pathWith([]), runInstall })),
    ).rejects.toThrow(/still not on PATH/);
  });

  it('respects ENNIO_SKIP_IDB_CHECK', async () => {
    const onPath = vi.fn(() => false);
    await ensureIdb(makeDeps({ env: { ENNIO_SKIP_IDB_CHECK: '1' }, onPath }));
    expect(onPath).not.toHaveBeenCalled();
  });
});
