# API and security

## The Profiles API

Profiles reach the browser only through these route handlers, never by querying Postgres from
a client. All of them require a session and answer `401` without one.

| Endpoint                      | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `GET /api/profiles`           | One page of the Deck, newest first                               |
| `POST /api/profiles/:id/keep` | Records a Keep, which drops the Profile from later pages         |
| `POST /api/profiles/:id/pass` | Records a Pass, which does the same without deleting the Profile |
| `GET /api/news`               | News about Kept Profiles, grouped by company, newest first       |

`GET /api/profiles` takes `?limit=` (1 to 50, default 20) and `?cursor=`, and answers with the
Profiles plus a `next_cursor`, which is `null` on the last page. The cursor is opaque: hand back
the one the previous page issued. Anything else, including a limit outside its range, gets a
`422` naming the field it objected to.

`GET /api/news` takes nothing, and answers with `companies`: each Kept Profile that has News at
or above the display threshold, its articles newest first, each carrying its `confidence`.

All of them share one budget of 60 requests a minute per account. Spend it and they answer
`429` with a `Retry-After` in seconds until the oldest request in the window ages out.

## Security

Every response through the Proxy carries a `Content-Security-Policy` (nonce-based, so no
inline script runs unless Next put it there), plus `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`. They are set in
`lib/http/security-headers.ts` and applied by the gate. See `docs/adr/0006`, which also explains
why the rate limit is where it is and what it does not cover.

CI runs `npm audit --audit-level=high` on every pull request, and `npm run check:bundle-secrets`
after the build, which greps the client output for the names and values of anything that must
stay on the server. Run that one yourself after `npm run build`.
