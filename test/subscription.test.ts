// Unit tests for _lib/subscription.ts against PayPal's documented resource
// shape (test/fixtures/, see fixtures/README.md for provenance). Exercises
// the parse + upsert path independent of signature verification — the part
// of the brief's §5 that genuinely can't be tested without a live PayPal
// webhook_id.
import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from '@neondatabase/serverless'
import type { WebhookEvent } from '../functions/_lib/paypal'
import {
  extractSubscriptionFields,
  upsertSubscription,
  UnattributedSubscriptionError,
} from '../functions/_lib/subscription'

import activated from './fixtures/billing-subscription-activated.json'
import updated from './fixtures/billing-subscription-updated.json'
import cancelled from './fixtures/billing-subscription-cancelled.json'
import expired from './fixtures/billing-subscription-expired.json'
import suspended from './fixtures/billing-subscription-suspended.json'
import updatedNoCustomId from './fixtures/billing-subscription-updated-no-custom-id.json'

function mockClient(queryImpl: (sql: string, params?: unknown[]) => unknown) {
  return { query: vi.fn(queryImpl) } as unknown as PoolClient
}

describe('extractSubscriptionFields', () => {
  it.each([
    ['activated', activated, 'ACTIVE'],
    ['updated', updated, 'ACTIVE'],
    ['cancelled', cancelled, 'CANCELLED'],
    ['expired', expired, 'EXPIRED'],
    ['suspended', suspended, 'SUSPENDED'],
  ])('pulls the right fields out of a %s event', (_label, fixture, expectedStatus) => {
    const fields = extractSubscriptionFields(fixture as WebhookEvent)
    expect(fields.paypalSubscriptionId).toBe('I-BW452GLLEP1G')
    expect(fields.paypalPlanId).toBe('P-5ML4271244454362WXNWU5NQ')
    expect(fields.status).toBe(expectedStatus)
    expect(fields.customId).toBe('4821')
  })

  it('handles a missing billing_info.next_billing_time (e.g. EXPIRED, terminal state)', () => {
    const fields = extractSubscriptionFields(expired as WebhookEvent)
    expect(fields.currentPeriodEnd).toBeNull()
  })

  it('carries next_billing_time through when present', () => {
    const fields = extractSubscriptionFields(activated as WebhookEvent)
    expect(fields.currentPeriodEnd).toBe('2026-09-02T10:15:00Z')
  })

  it('reads a null custom_id as null, not "undefined" or ""', () => {
    const fields = extractSubscriptionFields(updatedNoCustomId as WebhookEvent)
    expect(fields.customId).toBeNull()
  })
})

describe('upsertSubscription', () => {
  it('INSERTs ... ON CONFLICT DO UPDATE when custom_id is present (first-seen or repeat)', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = mockClient((sql, params) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: 1 }
    })

    await upsertSubscription(client, extractSubscriptionFields(activated as WebhookEvent))

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/INSERT INTO subscription/)
    expect(calls[0].sql).toMatch(/ON CONFLICT \(paypal_subscription_id\) DO UPDATE/)
    expect(calls[0].params).toEqual([4821, 'I-BW452GLLEP1G', 'P-5ML4271244454362WXNWU5NQ', 'ACTIVE', '2026-09-02T10:15:00Z'])
  })

  it('sets cancelled_at only when the upserted status is CANCELLED', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = mockClient((sql, params) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: 1 }
    })

    await upsertSubscription(client, extractSubscriptionFields(cancelled as WebhookEvent))

    expect(calls[0].sql).toMatch(/CASE WHEN EXCLUDED\.status = 'CANCELLED' THEN now\(\)/)
    expect(calls[0].params?.[3]).toBe('CANCELLED')
  })

  it('UPDATEs by paypal_subscription_id when custom_id is absent and a row already exists', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = mockClient((sql, params) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: 1 }
    })

    await upsertSubscription(client, extractSubscriptionFields(updatedNoCustomId as WebhookEvent))

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/^\s*UPDATE subscription SET/)
    expect(calls[0].sql).not.toMatch(/INSERT/)
  })

  it('throws UnattributedSubscriptionError when custom_id is absent and no row matches', async () => {
    const client = mockClient(() => ({ rows: [], rowCount: 0 }))

    await expect(
      upsertSubscription(client, extractSubscriptionFields(updatedNoCustomId as WebhookEvent)),
    ).rejects.toThrow(UnattributedSubscriptionError)
  })
})
