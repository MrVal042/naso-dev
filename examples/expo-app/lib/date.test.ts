import { formatDate } from './date';

test('formats a date', () => {
  expect(formatDate(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
});
