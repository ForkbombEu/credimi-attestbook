AttestBook records a durable, public event when a rulebook version is published.
This guide shows an independent issuer, verifier or catalogue how to discover
those events, register a webhook without an account, prove control of the
callback, verify signed deliveries and reconcile a missed notification against
the exact published version.

The [API reference](/docs) is the complete request and response contract for
every operation named here. This page explains the consumer-side flow and the
boundary of what AttestBook does.

## What AttestBook does and does not do

AttestBook appends one `rulebook.published` event for every **new** rulebook
publication and serves it on a public event feed. Once a subscription is active
and verified, AttestBook also sends a signed HTTP notification for later
publications of that same rulebook.

AttestBook does not push credentials, credential schemas or rulebook files to
your system, and this build has no complete issuer synchronisation. It does not
contact a callback during registration, does not backfill events for
publications that happened before the event feed existed, and does not retry a
terminal (for example `4xx`) delivery. Your consumer remains responsible for
fetching the pinned version, checking its digest and updating your own
catalogue. An issuer that wants consumers to observe its publications publishes
the version through AttestBook's authenticated publication route; that
publication is what appends the event.

The public feed and anonymous registration need no AttestBook account, provider
bearer token, browser session or CSRF token. Publishing and editing rulebooks
remain authenticated provider actions. This guide covers only the public
consumer side.

## Discover publications from the event feed

The public, unauthenticated discovery route is the publication-event feed:

```http
GET /api/v1/rulebooks/{rulebookId}/events
```

It returns durable publication events in ascending publication order. Each
entry pins the exact version and the immutable snapshot digest:

```json
{
  "data": [
    {
      "id": "…stable event id…",
      "format": "attestbook.rulebook-publication-event@1",
      "type": "rulebook.published",
      "rulebookId": "…",
      "version": "1.0",
      "contentDigest": "…64 lowercase hex characters…",
      "publishedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "nextCursor": "opaque-cursor-or-null",
    "hasMore": false
  }
}
```

Read a page with `limit` (default 50, maximum 100) and pass the opaque
`pagination.nextCursor` value as `cursor` until `hasMore` is `false`:

```bash
curl --fail --silent \
  'http://127.0.0.1:3000/api/v1/rulebooks/<rulebookId>/events?limit=50'
```

```bash
curl --fail --silent \
  'http://127.0.0.1:3000/api/v1/rulebooks/<rulebookId>/events?cursor=<nextCursor>'
```

A cursor names a feed position, not a credential. A publication that arrives
between two requests appears after the issued cursor; it never shifts,
duplicates or skips an earlier event. Persist the last event id you processed
and deduplicate by that id, because the feed is the source of truth for
reconciliation. An unknown rulebook answers `404 not_found`; an invalid `limit`
or `cursor` answers `400 invalid_request`.

The feed deliberately carries only public publication provenance: the stable
event id, the product shape version, the event type, the rulebook id, the exact
frozen version label, the snapshot digest and the publication timestamp. It
never includes the rulebook's working copy, provider identity, provider tokens,
credentials, version provenance or audit metadata. Supersession changes the
version's status to `historical` but keeps its event, and a new draft never
removes history.

## Register a callback anonymously

The rulebook subscription route registers one pending subscription:

```http
POST /api/v1/rulebooks/{rulebookId}/subscriptions
```

The request body carries `callbackUrl` and must use
`Content-Type: application/json`:

```bash
curl --fail --silent \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"callbackUrl":"https://consumer.example.org/attestbook/events"}' \
  'http://127.0.0.1:3000/api/v1/rulebooks/<rulebookId>/subscriptions'
```

`callbackUrl` must be an absolute public `https` URL without embedded
credentials or a fragment; a URL that violates this policy answers `400`. The
rulebook must already have at least one published or historical version,
otherwise the request answers `409`. Registration stores the subscription as `pending` and
performs no outbound request, so the callback host is not contacted until
verification.

Success is `201` with a `Location` header and one registered subscription:

```json
{
  "data": {
    "id": "<subscription id>",
    "rulebookId": "<rulebook id>",
    "callbackUrl": "https://consumer.example.org/attestbook/events",
    "state": "pending",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "managementToken": "ats_<opaque token>",
    "webhookSecret": "atw_<derived secret>"
  }
}
```

The `managementToken` and the `webhookSecret` are returned **exactly once**.
Store them now: the API never returns them again, and there is no recovery.
Register a new subscription if either secret is lost.

The `webhookSecret` member is present only when the deployment configured a
publication signing key. A deployment without one returns no secret and
performs no publication delivery; it never falls back to a generated or
committed key. If the deployment key changes, previously issued secrets stop
matching delivery, so register the subscription again under the current key.

Repeated registrations from one client are bounded by an in-process quota and
answer `429` with `Retry-After` beyond it. Registration never creates an event
notification by itself; it only creates the inert `pending` row.

## Prove control of the callback

The verification route starts the activation handshake:

```http
POST /api/v1/subscriptions/{subscriptionId}/verify
```

It needs no request body and requires the subscription's management token:

```bash
curl --fail --silent \
  --request POST \
  --header "Authorization: Bearer $MANAGEMENT_TOKEN" \
  'http://127.0.0.1:3000/api/v1/subscriptions/<subscriptionId>/verify'
```

AttestBook sends exactly one `POST` to the stored callback URL:

```http
Content-Type: application/json
Accept: application/json

{
  "type": "attestbook.subscription.verification@1",
  "challenge": "atv_<fresh challenge>",
  "expiresAt": "2026-01-01T00:05:00.000Z"
}
```

Your endpoint proves control by answering `200` with a JSON object containing
the same `challenge`:

```json
{ "challenge": "atv_<the same challenge>" }
```

The response must use `application/json` or a `+json` media type. Redirects are
not followed, and the response body is capped at 8 KiB. A redirect, another
status, a missing or different challenge, an expired challenge, an invalid or
oversized body or an unreachable endpoint leaves the subscription `pending` and
answers a typed failure. The challenge expires after five minutes and is stored
only as its SHA-256 hash. A failed attempt consumes it, so call the verify route
again for a new challenge; verification initiations are bounded to five per
subscription in ten minutes and answer `429` with `Retry-After` beyond that.

Calling verify on an already-active subscription returns it with `200` without
contacting the callback again. Verification only activates the subscription; it
delivers no event.

## Keep the management token confidential

The `ats_` management token is 256 random bits, unique to one subscription and
returned only once. AttestBook stores only its SHA-256 hash. Send it as
`Authorization: Bearer <managementToken>` on these management operations:

```text
POST   /api/v1/subscriptions/{subscriptionId}/verify
GET    /api/v1/subscriptions/{subscriptionId}
DELETE /api/v1/subscriptions/{subscriptionId}
GET    /api/v1/subscriptions/{subscriptionId}/deliveries
```

A provider bearer token, the administrator session cookie and every other
credential have no authority on these routes. A missing, malformed, invalid or
foreign token and an unknown subscription id all answer the same `401
unauthorized`, so the route does not disclose whether another subscriber's id
exists. A revoked subscription answers `404`.

`GET` is the only way to read the normalized callback URL you registered. The
response never contains the management token, the webhook secret or the stored
token hash. `DELETE` revokes the subscription immediately and answers `204`;
repeating it with the same valid token answers `204` again. Do not log tokens or
webhook secrets, and never put them in a URL or a browser page.

## Verify a signed delivery

After a publication, AttestBook durably enqueues one notification per active,
verified subscription of the rulebook and delivers it as an HTTP `POST`. Each
request carries these headers:

- `Content-Type`: `application/json`
- `X-AttestBook-Event-Id`: the stored event id, also present in the body
- `X-AttestBook-Event-Type`: `rulebook.published`
- `X-AttestBook-Timestamp`: the delivery attempt time, ISO 8601
- `X-AttestBook-Signature`: `v1=<lowercase hex HMAC-SHA-256>`

The body is the stored event projection, bounded to 16 KiB:

```json
{
  "id": "<stored event id>",
  "format": "attestbook.rulebook-publication-event@1",
  "type": "rulebook.published",
  "rulebookId": "<rulebook id>",
  "version": "1.0.1",
  "contentDigest": "<64 lowercase hex characters>",
  "publishedAt": "2026-01-01T00:00:00.000Z"
}
```

The signature commits to the exact body bytes, the timestamp and the event id.
The canonical signing input is UTF-8 with a single LF between four lines and no
trailing newline:

```text
attestbook.webhook-signing-input@1
<X-AttestBook-Timestamp>
<X-AttestBook-Event-Id>
<lowercase hex SHA-256 of the exact request body bytes>
```

Compute `HMAC-SHA-256(webhookSecret, canonicalInput)` and compare it in constant
time with the lowercase hex value after `v1=`. A generic Node/Bun verifier is:

```ts
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export function verifyPublicationWebhook(input: {
  secret: string
  body: Uint8Array
  eventId: string
  timestamp: string
  signature: string
}): boolean {
  const bodyDigest = createHash('sha256').update(input.body).digest('hex')
  const canonical = [
    'attestbook.webhook-signing-input@1',
    input.timestamp,
    input.eventId,
    bodyDigest,
  ].join('\n')
  const expected = createHmac('sha256', input.secret).update(canonical, 'utf8').digest()
  const presented = input.signature.startsWith('v1=')
    ? Buffer.from(input.signature.slice(3), 'hex')
    : Buffer.alloc(0)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}
```

Reject a timestamp outside a small tolerance window, and verify the signature
before parsing or acting on the body. `X-AttestBook-Event-Id` repeats the body
`id`, so it can be used as the deduplication key even before the body is parsed.

## Treat delivery as at-least-once

Delivery is asynchronous and at-least-once. A retry reuses the immutable event,
so the event id, body fields and subscription identity are identical across
attempts; only the retry timestamp, and therefore the signature, changes.
Deduplicate by event id: a notification may be delivered more than once.

- A transport failure (`timeout`, `dns_failure`, `network_failure`) and a `5xx`
  answer are retried.
- A `2xx` answer is success regardless of its body.
- A `4xx` answer, a `3xx` redirect, a blocked or non-public target, an oversized
  response and a subscription that is no longer active or bound to the current
  key are terminal and are not retried.
- With the default bounds, retries use exponential backoff from a 2-second base
  with jitter to a 15-minute cap, for at most 13 attempts and at most one hour
  from enqueue. A crashed process reclaims a claimed attempt after its 30-second
  lease expires.

The subscriber can read the bounded delivery status of recent events with the
management token:

```bash
curl --fail --silent \
  --header "Authorization: Bearer $MANAGEMENT_TOKEN" \
  'http://127.0.0.1:3000/api/v1/subscriptions/<subscriptionId>/deliveries'
```

`limit` defaults to 20 and is bounded at 100. The status view reports only
bookkeeping such as status, attempts, timestamps, a sanitized error category and
a terminal reason; the notification payload always comes from the event feed.

## Reconcile with the pinned published version

The public event feed is the source of truth when a notification is missed,
dropped or fails permanently. The feed never removes an event when a version is
superseded and never rewrites an earlier position, so a consumer can reconcile
from the last event id it processed. The reconciliation reads use these public
operations:

```text
GET /api/v1/rulebooks/{rulebookId}/events
GET /api/v1/rulebooks/{rulebookId}/versions/{version}/export
GET /api/v1/rulebooks/{rulebookId}/versions/{version}/content
```

1. Read the event feed from your last processed cursor and deduplicate the
   entries by `id`.
2. For each new event, fetch the exact immutable artifact for `version` with
   the export route. It is the publication-grade retrieval for a published or
   historical version and answers `409` for a draft.
3. Recompute SHA-256 over the exact bytes and compare it with the event's
   `contentDigest` before using the artifact.
4. Update your own catalogue from the pinned version, not from the rulebook's
   mutable working copy.

```bash
curl --fail --silent --output version.json \
  'http://127.0.0.1:3000/api/v1/rulebooks/<rulebookId>/versions/<version>/export'
sha256sum version.json
```

The content route returns the same exact stored bytes for any version, with a
`Content-Digest` header. The sibling export-manifest route describes the frozen
artifact without copying it. Both routes are documented in the
[API reference](/docs).

Exporting a published version is repeatable: renaming the rulebook, editing the
working copy or creating a new draft never changes the exported bytes, digest or
manifest. Supersession only changes the version's status from `published` to
`historical`; it does not delete the event or the artifact. The manifest makes
no signature claim, so integrity is the SHA-256 digest that you recompute.

## Implement the consumer checklist

- Register a callback over public HTTPS and store the one-time
  `managementToken` and `webhookSecret` immediately.
- Answer the verification challenge with the exact value before the five-minute
  expiry.
- Verify the signature over the raw body, timestamp and event id, and reject
  stale timestamps.
- Deduplicate notifications by `X-AttestBook-Event-Id`.
- Reconcile from the public event feed when a delivery is missed or fails
  permanently.
- Fetch the pinned version through the export route and check its digest before
  trusting or importing it.

The [API reference](/docs) lists every request and response schema, status code
and parameter for these operations.
