import crypto from 'crypto';
import {
  toPesewas,
  toCedis,
  normalizeGhanaPhone,
  normalizeMomoProvider,
  resolveProvider,
  generateReference,
  verifyWebhookSignature,
  chargeMobileMoney,
  initializeCheckout,
  PaystackError,
} from '../services/paystack.service';

// The gateway must never be reachable from a unit test: force "not configured"
// so the manual-mode branches are what actually run.
jest.mock('../config', () => ({
  __esModule: true,
  default: {
    env: 'test',
    paystack: { publicKey: '', secretKey: '' },
  },
}));

describe('toPesewas', () => {
  it('converts cedis to integer pesewas', () => {
    expect(toPesewas(50)).toBe(5000);
    expect(toPesewas(12.34)).toBe(1234);
    expect(toPesewas(0.01)).toBe(1);
  });

  it('does not lose a pesewa to floating point noise', () => {
    // 19.99 * 100 === 1998.9999999999998 in IEEE-754
    expect(toPesewas(19.99)).toBe(1999);
    expect(toPesewas(4.35)).toBe(435);
  });

  it('rejects zero, negative and non-numeric amounts', () => {
    expect(() => toPesewas(0)).toThrow(PaystackError);
    expect(() => toPesewas(-5)).toThrow(PaystackError);
    expect(() => toPesewas(NaN)).toThrow(PaystackError);
  });
});

describe('toCedis', () => {
  it('converts pesewas back to cedis', () => {
    expect(toCedis(5000)).toBe(50);
    expect(toCedis('1234')).toBe(12.34);
  });

  it('rounds to whole pesewas and survives junk input', () => {
    expect(toCedis(1234.6)).toBe(12.35);
    expect(toCedis('not-a-number')).toBe(0);
  });
});

describe('normalizeGhanaPhone', () => {
  it.each([
    ['0241234567', '0241234567'],
    ['+233241234567', '0241234567'],
    ['233 24 123 4567', '0241234567'],
    ['24-123-4567', '0241234567'],
    ['0501234567', '0501234567'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeGhanaPhone(input)).toBe(expected);
  });

  it.each([[''], [null], [undefined], ['12345'], ['0141234567'], ['02412345678'], ['abcdefg']])(
    'rejects %p',
    (input) => {
      expect(normalizeGhanaPhone(input as string | null | undefined)).toBeNull();
    }
  );
});

describe('normalizeMomoProvider', () => {
  it.each([
    ['MTN', 'mtn'],
    ['mtn momo', 'mtn'],
    ['MTN Mobile Money', 'mtn'],
    ['Vodafone', 'vod'],
    ['Telecel Cash', 'vod'],
    ['vod', 'vod'],
    ['AirtelTigo', 'atl'],
    ['Airtel', 'atl'],
    ['AT Money', 'atl'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeMomoProvider(input)).toBe(expected);
  });

  it('returns null for unknown or missing input', () => {
    expect(normalizeMomoProvider('')).toBeNull();
    expect(normalizeMomoProvider('bitcoin')).toBeNull();
    expect(normalizeMomoProvider(null)).toBeNull();
  });
});

describe('resolveProvider', () => {
  it('prefers an explicit network over the number prefix', () => {
    // 024 is an MTN prefix, but the cashier said Telecel — the cashier wins.
    expect(resolveProvider('telecel', '0241234567')).toBe('vod');
  });

  it('falls back to the Ghana prefix hint', () => {
    expect(resolveProvider(null, '0241234567')).toBe('mtn');
    expect(resolveProvider(undefined, '+233501234567')).toBe('vod');
    expect(resolveProvider(undefined, '0571234567')).toBe('atl');
  });

  it('returns null when it cannot tell', () => {
    expect(resolveProvider(null, '999')).toBeNull();
    expect(resolveProvider(null, null)).toBeNull();
  });
});

describe('generateReference', () => {
  it('produces unique references carrying the prefix', () => {
    const a = generateReference('momo');
    const b = generateReference('momo');
    expect(a).not.toBe(b);
    expect(a.startsWith('momo_')).toBe(true);
  });

  it('strips unsafe characters and defaults an empty prefix', () => {
    expect(generateReference('pos sale/01').startsWith('possale01_')).toBe(true);
    expect(generateReference('   ').startsWith('pos_')).toBe(true);
  });
});

describe('verifyWebhookSignature', () => {
  const SECRET = 'sk_test_webhook_secret';
  const sign = (body: string, key = SECRET) =>
    crypto.createHmac('sha512', key).update(Buffer.from(body, 'utf8')).digest('hex');

  beforeEach(() => {
    // The signature check is a no-op while unconfigured, so give it a key.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../config').default;
    config.paystack.secretKey = SECRET;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../config').default.paystack.secretKey = '';
  });

  it('accepts a correctly signed payload', () => {
    const body = '{"event":"charge.success","data":{"reference":"abc"}}';
    expect(verifyWebhookSignature(Buffer.from(body, 'utf8'), sign(body))).toBe(true);
  });

  it('accepts a string body identically to a Buffer', () => {
    const body = '{"event":"charge.success"}';
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const body = '{"event":"charge.success","data":{"amount":5000}}';
    const signature = sign(body);
    expect(verifyWebhookSignature(Buffer.from('{"event":"charge.success","data":{"amount":99999}}'), signature)).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const body = '{"event":"charge.success"}';
    expect(verifyWebhookSignature(Buffer.from(body, 'utf8'), sign(body, 'sk_test_someone_else'))).toBe(false);
  });

  it('rejects a missing or malformed signature without throwing', () => {
    const body = Buffer.from('{"event":"charge.success"}', 'utf8');
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
    expect(verifyWebhookSignature(body, '')).toBe(false);
    expect(verifyWebhookSignature(body, 'short')).toBe(false);
  });
});

describe('manual mode when no gateway key is configured', () => {
  it('never claims a mobile money charge went through', async () => {
    const result = await chargeMobileMoney({ amount: 25.5, phone: '0241234567', provider: 'mtn' });

    expect(result.mode).toBe('manual');
    expect(result.outcome).toBe('manual');
    expect(result.awaitingCustomerApproval).toBe(false);
    expect(result.message).toMatch(/recorded manually/i);
    expect(result.gatewayResponse).toEqual({
      mode: 'manual',
      reason: 'PAYSTACK_SECRET_KEY not configured',
    });
  });

  it('returns no authorization URL for hosted checkout', async () => {
    const result = await initializeCheckout({ amount: 100, email: 'kofi@example.com' });

    expect(result.mode).toBe('manual');
    expect(result.authorizationUrl).toBeUndefined();
    expect(result.reference).toBeTruthy();
  });
});
