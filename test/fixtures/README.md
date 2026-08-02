# Fixture provenance

PayPal's webhook-events documentation (`developer.paypal.com/api/rest/webhooks/event-names/`)
names each `BILLING.SUBSCRIPTION.*` event type but does not publish a full
example JSON payload per event. These fixtures are constructed field-by-field
against the authoritative source instead: the `subscription` and
`subscription_status` schemas in PayPal's own OpenAPI spec
(`github.com/paypal/paypal-rest-api-specifications`,
`openapi/billing_subscriptions_v1.json`), plus the webhook envelope shape
(`id`/`create_time`/`resource_type`/`event_type`/`summary`/`resource`)
confirmed from `openapi/notifications_webhooks_v1.json`'s
`verify-webhook-signature` request example (fetched 2026-08-02).

Every field present in these fixtures — `resource.id`, `plan_id`, `status`,
`custom_id`, `status_update_time`, `billing_info.next_billing_time` — is a
real field name from that spec, not invented. `custom_id` is set to a
trainee id (a plain integer, as a string, matching `subscription.trainee_id`
being `bigint`) to exercise `_lib/subscription.ts`'s attribution path — see
that module's docstring for why `custom_id` is the join key.
