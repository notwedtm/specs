# Live RPC compatibility checks

The runner checks a live endpoint against the YAML schemas and selected behaviors in this spec checkout. It uses the spec as the authority. Implementation support notes do not change expectations. It does not compare endpoints or require their slots, balances, or transaction history to match.

Use Node.js 20 or later. From `tooling/`:

```bash
npm ci
npm run compat -- --help
npm run compat -- --list
```

## Select a scope

Set the endpoint in the environment to keep it out of command output. These examples use a local validator:

```bash
export RPC_ENDPOINT=http://127.0.0.1:8899
export RPC_WS_ENDPOINT=ws://127.0.0.1:8900

# Select every method in the checked-out spec.
npm run compat -- --label local-validator

# Select categories or exact method names.
npm run compat -- --category Accounts
npm run compat -- --category Ledger,Tokens
npm run compat -- --method getAccountInfo,getProgramAccounts
npm run compat -- --method getBlock --method getTransaction

# List a selection without making network calls.
npm run compat -- --category Ledger --list
```

Category names are case-insensitive. Method names match wire names exactly. Repeated values and comma-separated values both work. Categories and methods intersect when used together. Unknown selectors and empty selections fail before network access.

| Category | Scope |
| --- | --- |
| Accounts | Account data, balances, multiple accounts, program accounts |
| Tokens | Token account and mint queries |
| Ledger | Blocks, slots, blockhashes, transaction history, transaction counts and signature status queries |
| Transactions | `sendTransaction` and `simulateTransaction` only |
| Cluster | Health, identity, version, epoch and cluster queries |
| Subscriptions | WebSocket methods |
| Other | Methods without a category assignment |

The selection always comes from the loaded spec. A method with no live adapter appears as **skipped**, including methods added to the spec later. Selecting the full spec does not claim every normative statement is tested. Submission, simulation, and airdrop methods have no adapter and never execute.

WebSocket tests require an explicit `--ws-endpoint` or `RPC_WS_ENDPOINT`. HTTP and WebSocket services may use different addresses or ports. The runner never guesses a WebSocket port. Without one, selected WebSocket methods appear as skipped. When testing only `accountUnsubscribe`, the runner creates a prerequisite subscription on the same connection.

## Reports and exit codes

```bash
npm run compat -- --category Ledger --label local-validator --format json --output /tmp/rpc-report.json
npm run compat -- --category Accounts --label local-validator --format html --output /tmp/rpc-report.html
```

Text is the default. JSON includes each probe, its category, source document, status, error code when relevant, and duration. It also includes the spec version, a SHA-256 fingerprint of the loaded methods, prose, schemas and errors, and coverage totals. HTML is a standalone report with a status filter and no external assets.

Use `--output` to write a report directly. For machine-readable stdout, use `npm run --silent compat -- --format json` to suppress npm's command banner.

| Status | Meaning |
| --- | --- |
| pass | The response matches the schema and the assertions for this probe. |
| fail | The response violates the JSON-RPC envelope, schema, expected error, or tested behavior. |
| unsupported | The endpoint returns `MethodNotFound` (-32601). |
| inconclusive | A declared availability error or missing live data prevents the behavior check. |
| error | A timeout, connection failure, HTTP error, size limit, server internal error, or runner error prevents evaluation. |
| skipped | A fixture, WebSocket endpoint, or live adapter is missing. |

Exit code `0` means every selected probe passed. Code `1` means at least one probe failed or a method was unsupported. Code `2` means the run is incomplete without a demonstrated incompatibility, or local configuration is invalid. A report is still written for partial runs. Pass counts measure executed probes, not full conformance. A method can have both passes and failures.

Reports exclude endpoint URLs, headers, fixture values, raw responses, and server error messages. Choose a non-sensitive `--label`; labels appear verbatim in text and JSON, and are escaped in HTML. Keep private fixture files and reports outside the repository. New report files use owner-only permissions. Existing file permissions are preserved.

## Fixtures and bounded discovery

The default account is the Clock sysvar. Random 32-byte addresses and 64-byte signatures exercise absent-account and absent-transaction behavior without submitting transactions. Ledger and token selections discover a recent finalized slot through `getSlot`, a small slot window through `getBlocks`, and one block through `getBlock`. Discovery can call these read methods even when they are not selected or not yet in the spec. It gathers a signature, an address with history, and token-owner information from that endpoint's block. Discovery responses are setup inputs, not conformance passes.

Use `--no-discover` to prevent setup reads. Provide `--fixtures /path/to/fixtures.json` for retained history, indexed accounts, or an endpoint that cannot serve ledger discovery. Supported JSON fields:

| Field | Purpose |
| --- | --- |
| `account` | Existing account for encoding probes; keep its data at most 128 bytes for base58 tests. Defaults to the Clock sysvar. |
| `slot` | Recent readable finalized block with transactions. |
| `signature` | Transaction visible at finalized commitment. |
| `address` | Address with recent transaction history. |
| `tokenOwner` | Owner with at least one indexed token account. |
| `tokenMint` | Mint held by that owner; required for the populated mint-filter probe. |
| `tokenProgram` | Token program for the owner-filter probe. Defaults to SPL Token. |
| `missingAccount` | Known absent address; otherwise generated randomly. |
| `missingSignature` | Known absent signature; otherwise generated randomly. |

For example, an account-only fixture file can contain:

```json
{
  "account": "SysvarC1ock11111111111111111111111111111111"
}
```

Fixture overrides take precedence over discovery. A null transaction or empty populated-token query is inconclusive, even when it matches the broad result schema. A random absent token owner may hit an index exclusion policy; that is also inconclusive. Supply fixtures appropriate to each endpoint's chain and retention. Fixtures do not define expected responses from another implementation.

All calls run sequentially. Defaults are a 100 ms delay before each HTTP call, a 10 second per-call deadline, and a 16 MiB response cap. Configure these with `--delay`, `--timeout`, and `--max-bytes`. HTTP redirects are refused. There are no automatic retries. Requests are bounded on the client; cancelling a request does not guarantee the server stops its work.

Program-account probes always use filters. They use the small sysvar program with a 40-byte data-size filter, or an SPL Token owner filter when a token-owner fixture is available. They request a zero-length data slice. Block probes request one block at a time, but full transaction variants can still be large. Choose limits for the target's capacity.

WebSocket probes subscribe to the Clock sysvar, check deduplication, observe notifications for `--notification-wait` milliseconds (default 3000), and test unsubscribe behavior. They check the notification schema, subscription id, base64 encoding, and the spec's requirement to ignore `dataSlice`. No notification during the observation window is inconclusive. Closing the socket releases all subscriptions.

For authentication, put a JSON object of string headers in an environment variable and name it with `--headers-env`. The same headers apply to HTTP and WebSocket connections:

```bash
npm run compat -- --headers-env RPC_TEST_HEADERS --category Accounts
```

## Coverage and extension points

The runner validates shared schema references with the same AJV helper used by the spec tooling. Behavior probes cover account encoding defaults and variants, null and duplicate account entries, response wrapping, filters, token ownership, block detail and reward flags, transaction encodings, history ordering and limits, required parameters, invalid keys, commitment rejection, and minimum context slots.

Error data is validated whenever the method declares a schema for that code. Only probes that declare an exact normative error message compare message text. A declared operational error is reported as inconclusive rather than a successful behavior test. Error code collisions or undeclared codes remain failures regardless of implementation notes.

This is sampled coverage. It does not exhaustively test fork behavior, retention boundaries, transaction version gating, pagination, all filter combinations, every error payload, every encoding's decoded contents, or all prose requirements. Numeric values use JavaScript `number`; comparisons cannot establish exact integer compatibility above `2^53`. A successful schema check alone cannot prove data correctness.

Add method probes in `src/compat/cases.ts` and category assignments in the same file. Each adapter refers to the loaded method's schema rather than copying its response type. `shape` assertions run before live-data availability checks; `check` assertions run after them. Use `nonempty` for behaviors that require actual data. Add deterministic tests in `test/compat.test.ts`, especially for false positives and coverage gaps. Never use internal endpoints in committed tests, examples, or reports.

Run `npm test`, `npm run validate`, `npm run build`, and `npx tsc --noEmit` before submitting changes.
