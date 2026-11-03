import type { MegaStorage } from './mega-account.blob-store';
import { MegaAccountService, TWO_FACTOR_REQUIRED } from './mega-account.service';

function fakeStorage(): MegaStorage {
  return {
    root: { name: '', directory: true, children: [] },
    toJSON: () => ({ sid: 'a-session-token' }),
    close: () => undefined,
  };
}

/** Service with the MEGA client replaced by a fake. */
class TestAccount extends MegaAccountService {
  public opened: { email: string; password: string; code?: string } | null = null;
  public revived: string | null = null;
  public failure: Error | null = null;

  protected override openSession(
    email: string,
    password: string,
    code?: string,
  ): Promise<MegaStorage> {
    this.opened = { email, password, code };
    return this.failure === null
      ? Promise.resolve(fakeStorage())
      : Promise.reject(this.failure);
  }

  protected override reviveSession(session: string): Promise<MegaStorage> {
    this.revived = session;
    return this.failure === null
      ? Promise.resolve(fakeStorage())
      : Promise.reject(this.failure);
  }
}

describe('MegaAccountService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('keeps the session and never the password', async () => {
    const service = new TestAccount();

    await service.signIn('gil@example.com', 'hunter2');

    expect(service.account()?.email).toBe('gil@example.com');
    expect(service.signedIn()).toBe(true);
    const stored = localStorage.getItem('emaki:mega-account:v1') ?? '';
    expect(stored).toContain('a-session-token');
    expect(stored).not.toContain('hunter2');
  });

  it('trims the email before logging in', async () => {
    const service = new TestAccount();

    await service.signIn('  gil@example.com ', 'hunter2');

    expect(service.opened?.email).toBe('gil@example.com');
  });

  it('reports a two-factor challenge as such, so the form can ask for a code', async () => {
    const service = new TestAccount();
    service.failure = new Error('API error -26: EMFAREQUIRED');

    let caught: Error | null = null;
    try {
      await service.signIn('gil@example.com', 'hunter2');
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.name).toBe(TWO_FACTOR_REQUIRED);
  });

  it('passes the two-factor code when the form supplies one', async () => {
    const service = new TestAccount();

    await service.signIn('gil@example.com', 'hunter2', '123456');

    expect(service.opened?.code).toBe('123456');
  });

  it('restores the saved session on a later launch instead of asking again', async () => {
    await new TestAccount().signIn('gil@example.com', 'hunter2');

    const later = new TestAccount();
    await later.storage();

    expect(later.revived).not.toBeNull();
    expect(later.signedIn()).toBe(true);
  });

  it('clears the account on sign out', async () => {
    const service = new TestAccount();
    await service.signIn('gil@example.com', 'hunter2');

    await service.signOut();

    expect(service.signedIn()).toBe(false);
    expect(localStorage.getItem('emaki:mega-account:v1')).toBeNull();
  });

  it('refuses to hand out a store when signed out', async () => {
    const service = new TestAccount();

    await expectAsync(service.store()).toBeRejectedWithError(/Sign in to MEGA first/);
  });
});
