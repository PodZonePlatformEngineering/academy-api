// Unit tests for _lib/paypal.ts's createOrder/captureOrder (PROJ-011/
// ACP-449) against a stubbed fetch — request shape (custom_id location,
// GBP amount, no application_context) and response parsing, independent of
// a live PayPal call. Mirrors test/paypal-subscriptions.test.ts's pattern.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createOrder, captureOrder, PayPalApiError } from '../functions/_lib/paypal'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createOrder', () => {
  it('sends custom_id on the purchase_unit, GBP amount, parses the approve link', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders')
      const body = JSON.parse(init!.body as string)
      expect(body.intent).toBe('CAPTURE')
      expect(body.purchase_units).toEqual([
        { custom_id: '42', amount: { currency_code: 'GBP', value: '2.00' } },
      ])
      expect(body.payment_source).toBeUndefined()
      expect((init!.headers as Record<string, string>)['PayPal-Request-Id']).toBeTruthy()
      return new Response(
        JSON.stringify({
          id: 'O-TESTORDER',
          status: 'CREATED',
          links: [
            { href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/O-TESTORDER', rel: 'self', method: 'GET' },
            { href: 'https://www.sandbox.paypal.com/checkoutnow?token=O-TESTORDER', rel: 'approve', method: 'GET' },
          ],
        }),
        { status: 201 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createOrder('https://api-m.sandbox.paypal.com', 'token', {
      amountValue: '2.00',
      customId: '42',
    })
    expect(result.id).toBe('O-TESTORDER')
    expect(result.links.find((l) => l.rel === 'approve')?.href).toContain('token=O-TESTORDER')
  })

  it('includes payment_source.paypal.experience_context only when both returnUrl and cancelUrl are given', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      expect(body.payment_source).toEqual({
        paypal: {
          experience_context: {
            return_url: 'https://example.com/return',
            cancel_url: 'https://example.com/cancel',
          },
        },
      })
      return new Response(JSON.stringify({ id: 'O-X', status: 'CREATED', links: [] }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await createOrder('https://api-m.sandbox.paypal.com', 'token', {
      amountValue: '5.00',
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
      createOrder('https://api-m.sandbox.paypal.com', 'token', { amountValue: '2.00', customId: '1' }),
    ).rejects.toBeInstanceOf(PayPalApiError)
  })
})

describe('captureOrder', () => {
  it('POSTs to the capture endpoint and returns id/status', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/O-TESTORDER/capture')
      expect(init?.method).toBe('POST')
      expect((init!.headers as Record<string, string>)['PayPal-Request-Id']).toBeTruthy()
      return new Response(JSON.stringify({ id: 'O-TESTORDER', status: 'COMPLETED' }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await captureOrder('https://api-m.sandbox.paypal.com', 'token', 'O-TESTORDER')
    expect(result).toEqual({ id: 'O-TESTORDER', status: 'COMPLETED' })
  })

  it('throws PayPalApiError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"name":"ORDER_NOT_APPROVED"}', { status: 422 })),
    )
    await expect(
      captureOrder('https://api-m.sandbox.paypal.com', 'token', 'O-UNAPPROVED'),
    ).rejects.toBeInstanceOf(PayPalApiError)
  })
})
