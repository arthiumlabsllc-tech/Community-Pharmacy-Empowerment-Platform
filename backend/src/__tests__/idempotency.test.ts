import { readClientRequestId, findReplay, recordReplay, pruneReplays } from '../utils/idempotency';

// Both collaborators are faked: the point of these tests is the decision the
// module makes around a database that may not have the table yet, not the SQL.
const mockQuery = jest.fn();

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => mockQuery(...args),
    transaction: jest.fn(),
    getClient: jest.fn(),
  },
}));

const mockError = jest.fn();
const mockWarn = jest.fn();

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    error: (...args: any[]) => mockError(...args),
    warn: (...args: any[]) => mockWarn(...args),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Only the two fields readClientRequestId touches are real; the cast keeps the
// tests readable without building an Express request.
const request = ({ header, body }: { header?: string | null; body?: unknown } = {}) =>
  ({
    header: jest.fn(() => header ?? undefined),
    body,
  }) as any;

const KEY = '3f2b8c1e-9d4a-4b6f-8e21-0a7c5d4b3e10';

beforeEach(() => {
  mockQuery.mockReset();
  mockError.mockReset();
  mockWarn.mockReset();
});

describe('readClientRequestId', () => {
  it('takes the key from the sync header', () => {
    expect(readClientRequestId(request({ header: KEY }))).toBe(KEY);
  });

  it('falls back to the body, because a queued payload carries it there too', () => {
    expect(readClientRequestId(request({ body: { client_request_id: KEY } }))).toBe(KEY);
  });

  it('prefers the header when both are present', () => {
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const req = request({ header: KEY, body: { client_request_id: other } });
    expect(readClientRequestId(req)).toBe(KEY);
  });

  it('normalises case so an uppercase key still matches its stored row', () => {
    expect(readClientRequestId(request({ header: KEY.toUpperCase() }))).toBe(KEY);
  });

  it.each([
    ['no key at all', request()],
    ['an empty header', request({ header: '' })],
    ['a truncated uuid', request({ header: KEY.slice(0, 20) })],
    ['a uuid with a suffix', request({ header: `${KEY}-extra` })],
    ['sql rather than a uuid', request({ header: "'; DROP TABLE sales; --" })],
    ['a non-string body value', request({ body: { client_request_id: 12345 } })],
  ])('rejects %s rather than reinterpreting it', (_label, req) => {
    // If the server hashed or truncated the value instead, the first attempt
    // and the retry would be stored under different keys, and the duplicate
    // would land with no explanation anywhere.
    expect(readClientRequestId(req)).toBeNull();
  });
});

describe('findReplay', () => {
  it('returns null without touching the database when there is no key', async () => {
    await expect(findReplay('pharmacy-1', null)).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns the stored response verbatim for a key already seen', async () => {
    const stored = { success: true, data: { id: 'patient-1' } };
    mockQuery.mockResolvedValue({ rows: [{ response_status: 201, response_body: stored }] });

    const replay = await findReplay('pharmacy-1', KEY);

    expect(replay).toEqual({ status: 201, body: stored });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM idempotency_keys'), [
      'pharmacy-1',
      KEY,
    ]);
  });

  it('scopes the lookup to the pharmacy so one pharmacy cannot replay another response', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await findReplay('pharmacy-1', KEY);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('pharmacy_id = $1');
    expect(sql).toContain('client_request_id = $2');
  });

  it('returns null on an unknown key', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(findReplay('pharmacy-1', KEY)).resolves.toBeNull();
  });

  it('survives a missing table instead of taking the endpoint down', async () => {
    // The realistic failure: 002_offline_sync.sql has not been applied yet.
    // Losing replay protection is bad; refusing to register a patient is worse.
    mockQuery.mockRejectedValue(new Error('relation "idempotency_keys" does not exist'));

    await expect(findReplay('pharmacy-1', KEY)).resolves.toBeNull();
    expect(mockError).toHaveBeenCalled();
  });
});

describe('recordReplay', () => {
  it('does nothing when the client sent no key', async () => {
    await recordReplay({
      pharmacyId: 'pharmacy-1',
      clientRequestId: null,
      endpoint: 'POST /patients',
      status: 201,
      body: { success: true },
    });

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('stores the response on the pool when no client is supplied', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });

    await recordReplay({
      pharmacyId: 'pharmacy-1',
      clientRequestId: KEY,
      endpoint: 'POST /patients',
      status: 201,
      body: { success: true, data: { id: 'patient-1' } },
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO idempotency_keys');
    expect(values[0]).toBe('pharmacy-1');
    expect(values[1]).toBe(KEY);
    expect(values[3]).toBe('POST /patients');
    expect(values[4]).toBe(201);
    expect(JSON.parse(values[5])).toEqual({ success: true, data: { id: 'patient-1' } });
  });

  it('ignores a second record for the same key so concurrent retries keep the first response', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });

    await recordReplay({
      pharmacyId: 'pharmacy-1',
      clientRequestId: KEY,
      endpoint: 'POST /patients',
      status: 201,
      body: {},
    });

    expect(mockQuery.mock.calls[0][0]).toContain(
      'ON CONFLICT (pharmacy_id, client_request_id) DO NOTHING'
    );
  });

  it('writes through the caller transaction when given one, so the key commits with the row', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rowCount: 1 });

    await recordReplay({
      pharmacyId: 'pharmacy-1',
      clientRequestId: KEY,
      endpoint: 'POST /inventory',
      status: 201,
      body: {},
      client: { query: clientQuery } as any,
    });

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('logs but does not throw when the record cannot be written', async () => {
    // The write it describes has already succeeded. Failing the request now
    // would leave the pharmacy believing a patient that exists was not saved.
    mockQuery.mockRejectedValue(new Error('permission denied'));

    await expect(
      recordReplay({
        pharmacyId: 'pharmacy-1',
        clientRequestId: KEY,
        endpoint: 'POST /screenings',
        status: 201,
        body: {},
      })
    ).resolves.toBeUndefined();

    expect(mockError).toHaveBeenCalled();
    const context = mockError.mock.calls[0][1];
    expect(context.endpoint).toBe('POST /screenings');
    expect(context.clientRequestId).toBe(KEY);
  });
});

describe('pruneReplays', () => {
  it('deletes by age and reports how many keys went', async () => {
    mockQuery.mockResolvedValue({ rowCount: 7 });

    await expect(pruneReplays()).resolves.toBe(7);
    expect(mockQuery.mock.calls[0][1]).toEqual(['30']);
  });

  it('accepts a different retention window', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });

    await pruneReplays(90);

    expect(mockQuery.mock.calls[0][1]).toEqual(['90']);
  });

  it('treats a rowCount of null as nothing deleted', async () => {
    mockQuery.mockResolvedValue({ rowCount: null });
    await expect(pruneReplays()).resolves.toBe(0);
  });
});
