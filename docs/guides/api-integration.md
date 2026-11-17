AttestBook's product API lives under `/api/v1`. Most reads are anonymous, every write is
authenticated, and the credential a client uses depends on where it runs. This guide covers
public reads, the envelopes and errors an integration must handle, the two provider write
credentials, the separate subscription-management token, and the stable generated references.
It does not repeat the operation-by-operation schema: the generated
[OpenAPI 3.1 contract](/openapi.json) is authoritative, and the
[interactive Scalar reference](/docs) renders it.

## Public reads need no credential

The provider projection, the rulebook catalogue, rulebook, attestation, schema-reference,
version, snapshot and export reads, the publication event feed, stored credential-schema
reads, structural credential validation and conformance runs are anonymous. Call them
directly:

```bash
curl --fail --silent \
  'http://127.0.0.1:3000/api/v1/providers' |
  jq '.data[].name'
```

Replace `http://127.0.0.1:3000` with the deployment's public origin.

Two read-shaped operations still require a provider credential because the server fetches a
remote document for them: import preview and issuer discovery. They are deliberately not
public.

## Success envelopes and errors

A single resource or action result is wrapped in `data`:

```json
{ "data": { "id": "...", "name": "PID Rulebook" } }
```

Paginated list endpoints add a `pagination` object with `limit`, `offset` and the filtered
`total`. The rulebook catalogue defaults to 50 rows and accepts up to 100 per request; the
publication event feed pages with an opaque `cursor` instead. `201` responses carry a
`Location` header for the created resource, and a delete or a logout answers `204`.

Every error, including an unknown route, uses one envelope:

```json
{ "error": { "code": "not_found", "message": "No route matches." } }
```

`code` is stable and machine-readable, `message` is safe to display and never contains a
token or credential material, and `details` appears when a stable sub-reason helps a client.
The codes an integration sees most are:

- `400 invalid_request` for malformed input;
- `401 unauthorized` for a missing, invalid or revoked credential;
- `403 csrf_failed` for a cookie-authenticated write without its CSRF token, and
  `403 forbidden` when the authenticated provider does not own the resource;
- `404 not_found`, `409 conflict` for a duplicate or conflicting state, and `409 immutable`
  for an edit of a published or historical version;
- `429 rate_limited` with a `Retry-After` header when a bound is reached, and typed `503`
  codes such as `registry_unavailable` or `auth_unavailable` when a service is not
  configured.

A `401` from a protected provider route carries
`WWW-Authenticate: Bearer realm="attestbook"`. The session-only `/api/v1/auth/me` and the
subscription-management routes deliberately do not, because the credential there is not a
provider bearer token.

## Authorize a write

Writes accept two credential paths to the **same existing provider**: a provider bearer token
for headless clients, or the optional administrator browser session for the supported UI
writes. Both resolve to the same provider actor, so ownership checks, `401`/`403` behavior and
audit attribution are identical.

A provider bearer token is not a browser session, and the administrator cookie is not a
bearer token. They are not interchangeable: only the cookie needs CSRF evidence on writes,
and only the bearer token can be used by a headless client.

### Provider bearer token for headless clients

Send the token provisioned for the provider in the standard bearer header:

```http
Authorization: Bearer att_<provider token>
```

Tokens use the `att_` prefix. They are generated out of band by the operator provisioning
path (there is no HTTP provider-administration route), returned exactly once, and stored only
as a SHA-256 hash, so the API can never echo one. A token can mutate only the rulebooks owned
by its provider; a foreign resource answers `403 forbidden`.

Use the bearer token from servers, CLIs and CI. A present `Authorization` header is
authoritative: a malformed, unknown or revoked bearer answers `401` and never falls back to
the browser session. Do not embed a provider token in the browser UI.

### Administrator browser session for UI writes

The optional single-administrator login is the credential for the in-browser writes the UI
supports: the rulebook editor's create, save and lifecycle actions, and the protected capture
correlation. It is configured from the server environment and bound to one existing
provider; it neither creates a provider nor mints or exposes a provider token. The catalogue,
detail, validation playground and capture explorer stay anonymous.

1. `POST /api/v1/auth/login` with `Content-Type: application/json` and
   `{"username": "...", "password": "..."}`. The response body returns the bound provider,
   its session `expiresAt` and a `csrfToken`, and sets the `attestbook_admin_session` cookie.
2. Keep the cookie only in the browser: it is `HttpOnly`, `SameSite=Lax`, `Path=/`, and has
   an eight-hour absolute lifetime. The browser sends it automatically.
3. Send `X-CSRF-Token` with the value from the login response on every non-GET request that
   authenticates with the cookie. A missing or wrong value answers `403 csrf_failed` and
   changes nothing.
4. After a reload, `GET /api/v1/auth/me` returns the live `csrfToken` with the provider
   projection. `POST /api/v1/auth/logout` revokes the session server-side and needs the CSRF
   token when a live session cookie is present.

Login requires a JSON body and rejects a foreign `Origin`/`Sec-Fetch-Site`; repeated failures
are rate limited. The cookie is a browser session, not an API token: do not copy it into an
`Authorization` header, and do not store a bearer token in the browser to avoid it.

### Which credential to use

- Anonymous client, reads only: no credential.
- Headless client that imports, previews, discovers, writes or publishes: a provider bearer
  token.
- Signed-in browser UI writing a draft or a capture correlation: the administrator session
  cookie plus `X-CSRF-Token`.

## Subscription management is a separate credential

Anonymous webhook subscriptions are the one unauthenticated write, and they have their own
one-time management credential. Registration is
`POST /api/v1/rulebooks/{rulebookId}/subscriptions` with
`Content-Type: application/json` and
`{"callbackUrl": "https://subscriber.example.test/webhook"}`. It needs no `Authorization`
header or cookie, requires a rulebook with a published or historical version, performs no
outbound request, and stores a `pending` subscription.

Success is `201` with a `Location` header and one `managementToken` (`ats_...`). When the
deployment configures a webhook signing key, the same response also carries one
`webhookSecret` (`atw_...`). Both are returned exactly once: the management token is stored
only as a SHA-256 hash and the webhook secret is derived from the deployment key and the
subscription id, never stored. No later response returns either, and the registration
response is marked `Cache-Control: no-store`.

Registration is anonymous, but management is not open: the `ats_` token is the only key to
that one subscription. Send it as `Authorization: Bearer ats_<management token>` only to the
subscription routes:

- `GET /api/v1/subscriptions/{subscriptionId}` reads its state, callback URL and timestamps.
- `POST /api/v1/subscriptions/{subscriptionId}/verify` runs the explicit callback challenge
  that activates it.
- `GET /api/v1/subscriptions/{subscriptionId}/deliveries` reads its bounded delivery history.
- `DELETE /api/v1/subscriptions/{subscriptionId}` revokes it; delivery eligibility ends
  immediately and a repeated authenticated delete is an idempotent `204`.

The management token cannot read or change rulebooks, and a provider bearer token, the
administrator session cookie or its CSRF token has no authority on these routes. Registration
grants no publication or provider authority: a new subscription stays `pending` and is never
delivery-eligible until verification proves control of the callback. Callback URLs must be
public `https` targets (a plain `http` loopback target is a test-only deployment opt-in),
they are re-validated at verification and delivery time, and redirects are never followed.
Registration is bounded per client, subscriptions are bounded per rulebook, and subscriptions
do not expire. The `atw_` webhook secret verifies notification signatures; it is not an API
credential.

## Read the generated API reference

The [OpenAPI 3.1 contract](/openapi.json) is generated from the same route and schema
definitions the server uses, and is served publicly without credentials. It describes the
`/api/v1` product API only, not the separate TS11 catalogue API.

```bash
curl --fail --silent \
  'http://127.0.0.1:3000/openapi.json' |
  jq '.openapi, .info.version'
```

The [interactive Scalar reference](/docs) renders that same-origin document in the browser.
It needs no login, loads bundled assets rather than a CDN, and is a separate page from this
guide. Use it to explore every operation, its request and response schemas, and the declared
security schemes.

`/api/v1` carries the major version in the URL. Within `v1` the contract evolves additively:
new endpoints and new optional fields are allowed, while removing or renaming a field,
changing a type or status, or making an optional request member required needs `/api/v2`.
Clients must tolerate unknown response fields. `/health`, `/openapi.json` and `/docs` are
unversioned operational and documentation endpoints; the document's `info.version` tracks
the contract, not the package version reported by `/health`. The exact request and response
shapes are always the generated document's; this guide intentionally does not embed them.

Continue with the [introduction guide](/guide/introduction) for the catalogue, validation
and capture-explorer workflows.
