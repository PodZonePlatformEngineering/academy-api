// Unit tests for the parts of _lib/paypal.ts that don't touch the network —
// event-type gating and transmission-header parsing. Signature verification
// itself (getAccessToken/verifyWebhookSignature) genuinely can't be tested
// without a live PayPal sandbox app; see README.md's credential-boundary
// section.
import { describe, expect, it } from 'vitest'
import {
  HANDLED_EVENT_TYPES,
  isHandledEventType,
  hasAllTransmissionHeaders,
  readTransmissionHeaders,
} from '../functions/_lib/paypal'

describe('HANDLED_EVENT_TYPES', () => {
  it('matches exactly the five event types the brief names (§4)', () => {
    expect([...HANDLED_EVENT_TYPES].sort()).toEqual(
      [
        'BILLING.SUBSCRIPTION.ACTIVATED',
        'BILLING.SUBSCRIPTION.CANCELLED',
        'BILLING.SUBSCRIPTION.EXPIRED',
        'BILLING.SUBSCRIPTION.SUSPENDED',
        'BILLING.SUBSCRIPTION.UPDATED',
      ].sort(),
    )
  })
})

describe('isHandledEventType', () => {
  it('accepts the five handled types', () => {
    for (const t of HANDLED_EVENT_TYPES) expect(isHandledEventType(t)).toBe(true)
  })

  it('rejects real-but-unhandled PayPal event types', () => {
    expect(isHandledEventType('BILLING.SUBSCRIPTION.CREATED')).toBe(false)
    expect(isHandledEventType('BILLING.SUBSCRIPTION.PAYMENT.FAILED')).toBe(false)
    expect(isHandledEventType('PAYMENT.AUTHORIZATION.CREATED')).toBe(false)
  })
})

describe('readTransmissionHeaders / hasAllTransmissionHeaders', () => {
  const fullHeaders = {
    'PAYPAL-TRANSMISSION-ID': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
    'PAYPAL-TRANSMISSION-TIME': '2026-08-02T10:15:00Z',
    'PAYPAL-CERT-URL': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-abc',
    'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
    'PAYPAL-TRANSMISSION-SIG': 'base64signature==',
  }

  it('reads all five PAYPAL-* headers PayPal actually sends', () => {
    const headers = readTransmissionHeaders(new Request('https://example.com', { headers: fullHeaders }))
    expect(headers).toEqual({
      transmissionId: fullHeaders['PAYPAL-TRANSMISSION-ID'],
      transmissionTime: fullHeaders['PAYPAL-TRANSMISSION-TIME'],
      certUrl: fullHeaders['PAYPAL-CERT-URL'],
      authAlgo: fullHeaders['PAYPAL-AUTH-ALGO'],
      transmissionSig: fullHeaders['PAYPAL-TRANSMISSION-SIG'],
    })
    expect(hasAllTransmissionHeaders(headers)).toBe(true)
  })

  it('flags a delivery missing any one required header', () => {
    for (const omit of Object.keys(fullHeaders)) {
      const partial = { ...fullHeaders }
      delete (partial as Record<string, string>)[omit]
      const headers = readTransmissionHeaders(new Request('https://example.com', { headers: partial }))
      expect(hasAllTransmissionHeaders(headers)).toBe(false)
    }
  })
})
