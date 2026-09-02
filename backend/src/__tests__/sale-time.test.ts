import { saleTime } from '../utils/sale-time';

/**
 * The expression is one line, but six report queries and the sale history all
 * depend on it, and getting it wrong moves a day's takings into the wrong
 * trading period — which is what the VAT return is filed on. These assertions
 * exist so a refactor that drops the COALESCE fails here rather than in a
 * pharmacy's books at the end of the month.
 */
describe('saleTime', () => {
  it('prefers the time the till recorded the sale over the time it synced', () => {
    expect(saleTime('s')).toBe('COALESCE(s.client_recorded_at, s.created_at)');
  });

  it('applies the alias to both columns so a join cannot pick up the wrong table', () => {
    expect(saleTime('sale')).toBe('COALESCE(sale.client_recorded_at, sale.created_at)');
  });

  it('keeps created_at as the fallback, because an online sale has no client timestamp', () => {
    expect(saleTime('s')).toContain('s.created_at');
  });
});
