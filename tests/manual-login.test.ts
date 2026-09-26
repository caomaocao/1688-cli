import { describe, expect, it, vi } from 'vitest';
import type { Cookie } from 'playwright';
import { hasLiveSession } from '../src/auth/cookies.js';
import { LOGIN_URL, waitForManualLogin, type LoginWaitPage } from '../src/session/manual-login.js';

const OFFER = 'https://detail.1688.com/offer/842620875447.html';
const LOGIN = 'https://login.1688.com/member/signin.htm?Done=x';

/** A page whose URL is set by `goto` (to `lands`, or the requested URL) or by the test. */
function fakePage(start: string, lands: Record<string, string> = {}) {
  let current = start;
  let closed = false;
  const page = {
    url: () => current,
    isClosed: () => closed,
    goto: vi.fn(async (u: string) => {
      current = lands[u] ?? u;
    }),
    close: () => {
      closed = true;
    },
    set: (u: string) => {
      current = u;
    },
  } satisfies LoginWaitPage & Record<string, unknown>;
  return page;
}

describe('waitForManualLogin', () => {
  it('opens the login page when 1688 served the offer anonymously, then returns once logged in', async () => {
    const page = fakePage(OFFER);
    let live = false;
    const onLoggedIn = vi.fn(async () => {});
    setTimeout(() => {
      live = true;
      page.set('https://www.1688.com/');
    }, 20);
    await waitForManualLogin(page, {
      returnUrl: OFFER,
      isLoggedIn: async () => live,
      pollMs: 5,
      timeoutMs: 2000,
      onLoggedIn,
    });
    expect(page.goto).toHaveBeenNthCalledWith(1, LOGIN_URL, expect.anything());
    expect(page.goto).toHaveBeenLastCalledWith(OFFER, expect.anything());
    expect(onLoggedIn).toHaveBeenCalledOnce();
  });

  it('does not count leaving the login page while the cookies still say logged out', async () => {
    const page = fakePage(LOGIN);
    setTimeout(() => page.set('https://www.1688.com/'), 10);
    const onLoggedIn = vi.fn(async () => {});
    await expect(
      waitForManualLogin(page, {
        returnUrl: OFFER,
        isLoggedIn: async () => false,
        pollMs: 5,
        timeoutMs: 60,
        onLoggedIn,
      }),
    ).rejects.toMatchObject({ code: 'NOT_LOGGED_IN', exitCode: 3 });
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it('does not count an offer load that bounces back to the login page', async () => {
    const page = fakePage('https://www.1688.com/', { [OFFER]: LOGIN });
    await expect(
      waitForManualLogin(page, {
        returnUrl: OFFER,
        isLoggedIn: async () => true,
        pollMs: 5,
        timeoutMs: 60,
      }),
    ).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });

  it('stops when the user closes the window', async () => {
    const page = fakePage(LOGIN);
    setTimeout(() => page.close(), 10);
    await expect(
      waitForManualLogin(page, {
        returnUrl: OFFER,
        isLoggedIn: async () => false,
        pollMs: 5,
        timeoutMs: 2000,
      }),
    ).rejects.toMatchObject({ code: 'CANCELED' });
  });
});

describe('hasLiveSession', () => {
  const c = (name: string, value: string, domain = '.1688.com') => ({ name, value, domain }) as Cookie;

  it('is live with unb and no logged-out marker', () => {
    expect(hasLiveSession([c('unb', '136693107'), c('__cn_logon__', 'true')])).toBe(true);
  });

  it('is dead without unb (the jar a logged-out profile keeps)', () => {
    expect(hasLiveSession([c('lid', 'x'), c('__cn_logon__', 'false')])).toBe(false);
  });

  it('is dead when 1688 marks the session logged out even if unb lingers', () => {
    expect(hasLiveSession([c('unb', '136693107'), c('__cn_logon__', 'false')])).toBe(false);
  });
});
