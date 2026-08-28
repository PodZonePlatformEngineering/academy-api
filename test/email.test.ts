// Unit tests for _lib/email.ts — sendEmail against a stubbed fetch (request
// shape, error parsing) and renderOrderConfirmationEmail (pure content
// building), independent of a live Resend call. Mirrors
// test/paypal-subscriptions.test.ts's stubbed-fetch pattern.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { sendEmail, renderOrderConfirmationEmail, ResendApiError } from '../functions/_lib/email'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendEmail', () => {
  it('sends a Bearer-authenticated POST and returns the id on success', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.resend.com/emails')
      expect(init!.method).toBe('POST')
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key')
      const body = JSON.parse(init!.body as string)
      expect(body).toEqual({
        from: 'noreply@vibecreations.net',
        to: 'trainee@example.com',
        subject: 'Subject',
        html: '<p>hi</p>',
        text: 'hi',
      })
      return new Response(JSON.stringify({ id: 'email-id-123' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendEmail('re_test_key', {
      from: 'noreply@vibecreations.net',
      to: 'trainee@example.com',
      subject: 'Subject',
      html: '<p>hi</p>',
      text: 'hi',
    })
    expect(result.id).toBe('email-id-123')
  })

  it('throws ResendApiError with the response message on a non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              statusCode: 403,
              message: 'The vibecreations.net domain is not verified. Please, add and verify your domain on https://resend.com/domains',
              name: 'validation_error',
            }),
            { status: 403 },
          ),
      ),
    )

    await expect(
      sendEmail('re_test_key', {
        from: 'noreply@vibecreations.net',
        to: 'trainee@example.com',
        subject: 'Subject',
        html: '<p>hi</p>',
        text: 'hi',
      }),
    ).rejects.toThrow(ResendApiError)
  })
})

describe('renderOrderConfirmationEmail', () => {
  it('includes plan/amount/next-billing-date when given, greets by name', () => {
    const email = renderOrderConfirmationEmail({
      to: 'trainee@example.com',
      traineeName: 'Eben',
      planId: 'P-5ML4271244454362WXNWU5NQ',
      amount: { currencyCode: 'GBP', value: '1.00' },
      nextBillingTime: '2026-09-02T10:15:00Z',
      supportEmail: 'podzone.cloud@gmail.com',
    })
    expect(email.subject).toContain('confirmed')
    expect(email.text).toContain('Hi Eben,')
    expect(email.text).toContain('P-5ML4271244454362WXNWU5NQ')
    expect(email.text).toContain('1.00 GBP')
    expect(email.text).toContain('2026-09-02T10:15:00Z')
    expect(email.text).toContain('podzone.cloud@gmail.com')
    expect(email.html).toContain('P-5ML4271244454362WXNWU5NQ')
  })

  it('omits amount/next-billing-date lines and uses a plain greeting when not given', () => {
    const email = renderOrderConfirmationEmail({
      to: 'trainee@example.com',
      traineeName: null,
      planId: null,
      amount: null,
      nextBillingTime: null,
      supportEmail: 'podzone.cloud@gmail.com',
    })
    expect(email.text).toContain('Hi,')
    expect(email.text).not.toContain('Plan:')
    expect(email.text).not.toContain('Amount:')
    expect(email.text).not.toContain('Next billing date:')
  })
})
