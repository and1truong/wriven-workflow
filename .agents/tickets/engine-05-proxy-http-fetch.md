# engine-05: Egress proxy with per-run allowlist and token; `http_fetch` with `on_error` and `retry`

**Spec:** [pipeline-format](../specs/pipeline-format.md) (`http_fetch`), [permissions](../specs/permissions.md) (network entries, proxy), [delivery-semantics](../specs/delivery-semantics.md) (strict errors, `on_error: skip`, retry), [threat-model](../specs/threat-model.md) (T1, T8, T9).

**To build:** An HTTP CONNECT proxy on `127.0.0.1:<ephemeral>` started per run with the run's host allowlist and a per-run token (`Proxy-Authorization`); 403 for unlisted hosts reported as `permission_denied`, 407 without token. The Seatbelt profile from engine-04 now allows outbound only to that port. `http_fetch`: GET per URL with concurrency 4, header allowlist, `timeout`, `max_bytes`, at most 3 redirects re-checked by the proxy, `on_error: fail|skip` with warnings, optional `retry`. URL validation rules (`https` only, no IP literals, no `localhost`/`.local`/private ranges, no credentials). Permissions derivation and sentences for network, retry and skip. An in-process fixture HTTPS server for tests (self-signed CA trusted only by the test run).

**Blocked by:** [engine-04](engine-04-sandbox-seatbelt-watchdog.md).

**Verification:** Fixture server with three URLs, one returning 503: without `on_error` → `failed` at `fetch` with the 503 in the message; with `skip` → `succeeded`, one warning naming the URL. `CONNECT evil.example:443` → 403 and `permission_denied` with that host in the report; without token → 407. Redirect to an unlisted host → `permission_denied`. URL rule violations each → `url_not_allowed`. `retry: {max_attempts: 3}` against a server that fails twice → success, report shows attempts. A body over `max_bytes` → error, not truncation. Permission sentences for the three-host example match [permissions](../specs/permissions.md#worked-example) lines 2 and 3.

**Status:** not started

- [ ] Proxy with allowlist, token, 403/407, logging to report
- [ ] `http_fetch` with all config fields and URL rules
- [ ] `on_error: skip`, warnings, `retry`
- [ ] Permissions derivation and sentences for network
- [ ] Fixture HTTPS server and tests
