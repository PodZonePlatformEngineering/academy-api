// Unit tests for _lib/paypal.ts's createSubscription/getSubscription
// (PROJ-011/T-152) against a stubbed fetch — request shape (custom_id in
// particular) and response parsing, independent of a live PayPal call
// (that's test/scripts/live-verify-custom-id.md's job, see README).
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  createSubscription,
  getSubscription,
  refundCapture,
  cancelSubscription,
  PayPalApiError,
} from '../functions/_lib/paypal'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSubscription', () => {
  it('sends custom_id and plan_id, parses the approve link out of the response', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api-m.sandbox.paypal.com/v1/billing/subscriptions')
      const body = JSON.parse(init!.body as string)
      expect(body.plan_id).toBe('P-TEST123')
      expect(body.custom_id).toBe('42')
      expect(body.application_context).toBeUndefined()
      return new Response(
        JSON.stringify({
          id: 'I-TESTSUB',
          status: 'APPROVAL_PENDING',
          custom_id: '42',
          links: [
            { href: 'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-TESTSUB', rel: 'self', method: 'GET' },
            { href: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-X', rel: 'approve', method: 'GET' },
          ],
        }),
        { status: 201 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createSubscription('https://api-m.sandbox.paypal.com', 'token', {
      planId: 'P-TEST123',
      customId: '42',
    })
    expect(result.id).toBe('I-TESTSUB')
    expect(result.custom_id).toBe('42')
    expect(result.links.find((l) => l.rel === 'approve')?.href).toContain('ba_token=BA-X')
  })

  it('includes application_context only when both returnUrl and cancelUrl are given', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      expect(body.application_context).toEqual({
        user_action: 'SUBSCRIBE_NOW',
        return_url: 'https://example.com/return',
        cancel_url: 'https://example.com/cancel',
      })
      return new Response(JSON.stringify({ id: 'I-X', status: 'APPROVAL_PENDING', links: [] }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await createSubscription('https://api-m.sandbox.paypal.com', 'token', {
      planId: 'P-TEST123',
      customId: '42',
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    })
  })

  it('throws PayPalApiError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"name":"INVALID_REQUEST"}', { status: 400 })),
    )
    await expect(
      createSubscription('https://api-m.sandbox.paypal.com', 'token', { planId: 'P-X', customId: '1' }),
    ).rejects.toBeInstanceOf(PayPalApiError)
  })
})

describe('getSubscription', () => {
  it('fetches the subscription resource by id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-TESTSUB')
      return new Response(JSON.stringify({ id: 'I-TESTSUB', status: 'APPROVAL_PENDING', custom_id: '42', links: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await getSubscription('https://api-m.sandbox.paypal.com', 'token', 'I-TESTSUB')
    expect(result.custom_id).toBe('42')
  })
})

// ACP-441
describe('refundCapture', () => {
  it('POSTs an empty body (full refund) to the capture-id refund endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/8HN29713RM123456B/refund')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('{}')
      expect((init!.headers as Record<string, string>)['PayPal-Request-Id']).toBeTruthy()
      return new Response(JSON.stringify({ id: '3TY12345AB678901C', status: 'COMPLETED' }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await refundCapture('https://api-m.sandbox.paypal.com', 'token', '8HN29713RM123456B')
    expect(result).toEqual({ id: '3TY12345AB678901C', status: 'COMPLETED' })
  })

  it('throws PayPalApiError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 })),
    )
    await expect(
      refundCapture('https://api-m.sandbox.paypal.com', 'token', 'NOSUCHCAPTURE'),
    ).rejects.toBeInstanceOf(PayPalApiError)
  })
})

// ACP-445
describe('cancelSubscription', () => {
  it('posts the reason to the cancel endpoint and resolves on a 204', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-TESTSUB/cancel')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(init!.body as string)
      expect(body).toEqual({ reason: 'Cancelled by trainee' })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      cancelSubscription('https://api-m.sandbox.paypal.com', 'token', 'I-TESTSUB', 'Cancelled by trainee'),
    ).resolves.toBeUndefined()
  })

  it('throws PayPalApiError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 })),
    )
    await expect(
      cancelSubscription('https://api-m.sandbox.paypal.com', 'token', 'I-MISSING', 'Cancelled by trainee'),
    ).rejects.toBeInstanceOf(PayPalApiError)
  })
})
