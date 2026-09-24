import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { InstallCapability } from './install';
import type { Condition, StatusCentre } from '../ui/status';

const env = vi.hoisted(() => ({
  storage: { supported: true, persisted: false } as { supported: boolean; persisted?: boolean },
  standalone: false,
  capability: { kind: 'none', reason: 'unsupported' } as InstallCapability,
  listeners: [] as Array<() => void>,
}));

vi.mock('./storage', () => ({
  bootstrapStorage: vi.fn(async () => env.storage),
  isStandalone: () => env.standalone,
}));

vi.mock('./install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./install')>()),
  createInstallWatcher: () => ({
    capability: () => env.capability,
    onChange: (listener: () => void) => void env.listeners.push(listener),
  }),
}));

const { INSTALL_RATIONALE, IOS_INSTALL_STEPS } = await import('./install');
const { renderInstallSheet, startStorageOnboarding } = await import('./onboarding');

let status: { setCondition: Mock<StatusCentre['setCondition']> };
let showInstallSteps: Mock<() => void>;

async function start(): Promise<void> {
  startStorageOnboarding({ status, showInstallSteps });
  await vi.waitFor(() => expect(status.setCondition).toHaveBeenCalled());
}
const lastCondition = () => status.setCondition.mock.lastCall;

/** The storage banner now showing — failing the test, rather than typing around it, if none is. */
function banner(): Condition & { action: NonNullable<Condition['action']> } {
  const condition = lastCondition()?.[1];
  if (!condition) throw new Error('no storage banner is showing');
  return condition as Condition & { action: NonNullable<Condition['action']> };
}

beforeEach(() => {
  env.storage = { supported: true, persisted: false };
  env.standalone = false;
  env.capability = { kind: 'none', reason: 'unsupported' };
  env.listeners = [];
  status = { setCondition: vi.fn() };
  showInstallSteps = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('storage onboarding (C1, C2)', () => {
  it('says nothing once storage is persistent — nothing for the user to do', async () => {
    env.storage = { supported: true, persisted: true };
    await start();
    expect(lastCondition()).toEqual(['storage', null]);
  });

  it('says plainly that downloads are off when the browser cannot keep them', async () => {
    env.storage = { supported: false };
    await start();
    expect(banner().message).toMatch(/downloads are off/);
  });

  it('offers a real install button where the browser has one', async () => {
    const prompt = vi.fn(async () => 'dismissed' as const);
    env.capability = { kind: 'prompt', prompt };
    await start();

    const condition = banner();
    expect(condition.action.label).toBe('Install');
    condition.action.onSelect();
    expect(prompt).toHaveBeenCalled();
  });

  it('checks again after an accepted install, since installing is what grants storage', async () => {
    env.capability = { kind: 'prompt', prompt: async () => 'accepted' as const };
    await start();
    env.storage = { supported: true, persisted: true };

    banner().action.onSelect();

    await vi.waitFor(() => expect(lastCondition()).toEqual(['storage', null]));
  });

  it('says what to do instead when the install prompt will not open', async () => {
    env.capability = {
      kind: 'prompt',
      prompt: async () => {
        // The watcher drops a failed prompt, so the next check finds none on offer.
        env.capability = { kind: 'none', reason: 'unsupported' };
        env.listeners.forEach((listener) => listener());
        throw new DOMException('The prompt() method must be called with a user gesture', 'NotAllowedError');
      },
    };
    await start();

    banner().action.onSelect();

    // Not overwritten by the re-check the dropped prompt triggers.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vi.waitFor(() => expect(banner().message).toMatch(/install prompt didn’t open.*browser’s menu/));
    expect(banner().message).toMatch(/NotAllowedError|user gesture/);
  });

  it('puts the iOS walkthrough behind a button rather than over the map', async () => {
    env.capability = { kind: 'manual-ios' };
    await start();

    const condition = banner();
    expect(condition.message).toMatch(/Home Screen/);
    condition.action.onSelect();
    expect(showInstallSteps).toHaveBeenCalled();
  });

  it('tells an installed app it is waiting on the browser, and a tab that it needs installing', async () => {
    env.standalone = true;
    await start();
    expect(banner().message).toMatch(/hasn’t granted/);

    status.setCondition.mockClear();
    env.standalone = false;
    await start();
    expect(banner().message).toMatch(/until ratmap is installed/);
  });

  it('re-checks when the install situation changes', async () => {
    await start();
    env.storage = { supported: true, persisted: true };

    env.listeners[0]();

    await vi.waitFor(() => expect(lastCondition()).toEqual(['storage', null]));
  });
});

describe('renderInstallSheet', () => {
  it('explains why, then lists the Share-sheet steps in order', () => {
    const body = document.createElement('div');
    renderInstallSheet(body);

    expect(body.querySelector('.sheet-lede')!.textContent).toBe(INSTALL_RATIONALE);
    expect([...body.querySelectorAll('.install-steps li')].map((li) => li.textContent)).toEqual([
      ...IOS_INSTALL_STEPS,
    ]);
  });
});
