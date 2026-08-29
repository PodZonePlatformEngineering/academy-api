// Unit tests for _lib/quota.ts's one-off pricing helpers (PROJ-011/
// ACP-449) — pure, no DB/network, so the multiplier logic (computed off
// resolveQuotaGrantAmount, never a second hardcoded absolute) is checked in
// isolation from the webhook/orders.ts callers that use it.
import { describe, expect, it } from 'vitest'
import {
  isOneOffPriceGbp,
  resolveOneOffQuotaAmount,
  resolveQuotaGrantAmount,
  DEFAULT_QUOTA_GRANT_AMOUNT,
} from '../functions/_lib/quota'

describe('isOneOffPriceGbp', () => {
  it('accepts exactly the two supported amounts', () => {
    expect(isOneOffPriceGbp('2.00')).toBe(true)
    expect(isOneOffPriceGbp('5.00')).toBe(true)
  })

  it('rejects anything else, including near-miss formatting', () => {
    for (const bad of ['2', '5', '0.01', '500', '2.000', '-2.00', 'GBP', '']) {
      expect(isOneOffPriceGbp(bad)).toBe(false)
    }
  })
})

describe('resolveOneOffQuotaAmount', () => {
  it('credits 2x/5x the production grant amount (£2 -> 100, £5 -> 250)', () => {
    expect(resolveQuotaGrantAmount({})).toBe(DEFAULT_QUOTA_GRANT_AMOUNT)
    expect(resolveOneOffQuotaAmount({}, '2.00')).toBe(DEFAULT_QUOTA_GRANT_AMOUNT * 2)
    expect(resolveOneOffQuotaAmount({}, '5.00')).toBe(DEFAULT_QUOTA_GRANT_AMOUNT * 5)
    expect(resolveOneOffQuotaAmount({}, '2.00')).toBe(100)
    expect(resolveOneOffQuotaAmount({}, '5.00')).toBe(250)
  })

  it('stays in sync with a QA QUOTA_GRANT_AMOUNT override, never a second hardcoded number', () => {
    expect(resolveOneOffQuotaAmount({ QUOTA_GRANT_AMOUNT: '2' }, '2.00')).toBe(4)
    expect(resolveOneOffQuotaAmount({ QUOTA_GRANT_AMOUNT: '2' }, '5.00')).toBe(10)
  })
})
