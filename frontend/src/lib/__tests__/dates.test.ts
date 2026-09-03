import {
  daysBetweenUtcDays,
  daysUntilExpiry,
  expiryCountdownLabel,
  formatDateUtc,
  toUtcDay,
  todayUtcDay,
} from '../dates';

/**
 * The same formatting the module does, in an arbitrary zone.
 *
 * An independent oracle rather than a call into the module: a test that asks the
 * code under test what it would print in New York and then compares it with what
 * the code under test prints in UTC proves nothing.
 */
function formatDateIn(timeZone: string, value = '2026-06-01'): string {
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  });
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('toUtcDay', () => {
  it('passes a DATE column through unchanged', () => {
    expect(toUtcDay('2026-06-01')).toBe('2026-06-01');
  });

  it('takes the day out of a timestamp, which is how node-postgres can return one', () => {
    expect(toUtcDay('2026-06-01T00:00:00.000Z')).toBe('2026-06-01');
  });

  it('returns null for the three ways a date can be absent', () => {
    expect(toUtcDay(null)).toBeNull();
    expect(toUtcDay(undefined)).toBeNull();
    expect(toUtcDay('')).toBeNull();
  });

  it('returns null rather than NaN for something unparseable', () => {
    // A NaN day would flow into every comparison below and make them all false,
    // which reads as "not expired" — the one wrong answer that sells stock.
    expect(toUtcDay('not a date')).toBeNull();
  });
});

describe('formatDateUtc', () => {
  it('renders the day the column holds', () => {
    expect(formatDateUtc('2026-06-01')).toBe('1 Jun 2026');
  });

  it('is not the day before, which is what a machine west of Greenwich would show', () => {
    expect(formatDateIn('America/New_York')).toBe('31 May 2026');
    expect(formatDateIn('UTC')).toBe('1 Jun 2026');
    expect(formatDateIn('Africa/Accra')).toBe('1 Jun 2026');
    expect(formatDateUtc('2026-06-01')).toBe(formatDateIn('UTC'));
  });

  it('asks for UTC explicitly, so the machine zone cannot pick the day', () => {
    // The test above only fails west of Greenwich: at UTC+0 local and UTC
    // formatting agree, so a regression that dropped timeZone would still pass
    // on the machine this suite was written on. This pins the mechanism.
    const spy = jest.spyOn(Date.prototype, 'toLocaleDateString');
    formatDateUtc('2026-06-01');
    const zones = spy.mock.calls.map(
      (call) => (call[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone
    );
    expect(zones).toEqual(['UTC']);
  });

  it('hands back what it was given when it cannot read it', () => {
    expect(formatDateUtc('pending')).toBe('pending');
  });

  it('is empty for an absent date, so a blank cell stays blank', () => {
    expect(formatDateUtc(null)).toBe('');
    expect(formatDateUtc(undefined)).toBe('');
    expect(formatDateUtc('')).toBe('');
  });
});

describe('daysBetweenUtcDays', () => {
  it('is positive forward and negative back', () => {
    expect(daysBetweenUtcDays('2026-06-01', '2026-06-11')).toBe(10);
    expect(daysBetweenUtcDays('2026-06-11', '2026-06-01')).toBe(-10);
  });

  it('is zero for the same day', () => {
    expect(daysBetweenUtcDays('2026-06-01', '2026-06-01')).toBe(0);
  });

  it('counts days and not months, across a year boundary', () => {
    expect(daysBetweenUtcDays('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysBetweenUtcDays('2024-02-28', '2024-03-01')).toBe(2); // 2024 is a leap year
    expect(daysBetweenUtcDays('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('is null when either side is not a day', () => {
    expect(daysBetweenUtcDays('2026-06-01', 'nonsense')).toBeNull();
    expect(daysBetweenUtcDays('', '2026-06-01')).toBeNull();
  });
});

describe('daysUntilExpiry', () => {
  it('counts down to the date', () => {
    expect(daysUntilExpiry('2026-06-11', '2026-06-01')).toBe(10);
    expect(daysUntilExpiry('2026-06-01', '2026-06-01')).toBe(0);
  });

  it('is negative the day after the expiry, which is when the server stops selling it', () => {
    expect(daysUntilExpiry('2026-05-31', '2026-06-01')).toBe(-1);
  });

  it('is null for a product with no date, which is not the same as never expiring', () => {
    // Undated stock is sellable but untraceable; the caller has to be able to
    // tell that apart from a date far in the future.
    expect(daysUntilExpiry(null)).toBeNull();
    expect(daysUntilExpiry(undefined)).toBeNull();
  });

  it('does not depend on the time of day', () => {
    // The bug this replaces: `expiry - Date.now()` with a Math.ceil spent a
    // full day returning -0, which is not < 0, so stock that had already
    // expired read "Exp 0d" — a countdown that had run out but had not yet
    // become the refusal the server would make.
    jest.useFakeTimers().setSystemTime(new Date('2026-06-02T00:30:00Z'));
    expect(todayUtcDay()).toBe('2026-06-02');
    expect(daysUntilExpiry('2026-06-01')).toBe(-1);

    jest.setSystemTime(new Date('2026-06-02T23:59:00Z'));
    expect(daysUntilExpiry('2026-06-01')).toBe(-1);
  });

  it('still counts down correctly later in the same day', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T18:45:00Z'));
    expect(daysUntilExpiry('2026-06-01')).toBe(0);
    expect(daysUntilExpiry('2026-06-02')).toBe(1);
  });
});

describe('expiryCountdownLabel', () => {
  it('names an expired lot rather than counting it', () => {
    expect(expiryCountdownLabel('2026-05-31', 90, '2026-06-01')).toEqual({
      text: 'Expired',
      expired: true,
    });
  });

  it('counts a lot that is still in date, including on the day itself', () => {
    expect(expiryCountdownLabel('2026-06-01', 90, '2026-06-01')).toEqual({
      text: 'Exp 0d',
      expired: false,
    });
    expect(expiryCountdownLabel('2026-06-11', 90, '2026-06-01')).toEqual({
      text: 'Exp 10d',
      expired: false,
    });
  });

  it('says nothing once the date is outside the window', () => {
    expect(expiryCountdownLabel('2026-09-01', 90, '2026-06-01')).toBeNull();
    // The window is inclusive of its own last day.
    expect(expiryCountdownLabel('2026-08-30', 90, '2026-06-01')).toEqual({
      text: 'Exp 90d',
      expired: false,
    });
  });

  it('honours a narrower window, which is what the inventory table asks for', () => {
    expect(expiryCountdownLabel('2026-06-20', 30, '2026-06-01')).toEqual({
      text: 'Exp 19d',
      expired: false,
    });
    expect(expiryCountdownLabel('2026-07-20', 30, '2026-06-01')).toBeNull();
  });

  it('never counts an expired lot as outside the window', () => {
    // A date far in the past is a long way from today, so a naive
    // `days > withinDays` test would hide the one badge that matters most.
    expect(expiryCountdownLabel('2020-01-01', 30, '2026-06-01')).toEqual({
      text: 'Expired',
      expired: true,
    });
  });

  it('is null when there is no date at all', () => {
    expect(expiryCountdownLabel(null)).toBeNull();
  });
});
