import { createHash } from 'node:crypto'
import type { ValidateFunction } from 'ajv'
import type { MethodSource, SpecSource } from '../loader.js'
import { compileWithComponents } from '../examples.js'
import { category, CLOCK, initialFixtures, probes, type Fixtures, type Probe } from './cases.js'
import { httpTransport, ProtocolError, SocketTransport, type Call, type TransportOptions } from './transport.js'

export type Status = 'pass' | 'fail' | 'unsupported' | 'inconclusive' | 'error' | 'skipped'
export interface Result {
  method: string
  category: string
  transport: string
  probe: string
  source: string
  status: Status
  detail: string
  durationMs: number
  code?: number
}
export interface Report {
  formatVersion: 1
  target: string
  startedAt: string
  durationMs: number
  spec: { version: string, sha256: string }
  scope: string[]
  summary: Record<Status, number>
  coverage: { selectedMethods: number, methodsWithPass: number, methodsWithGaps: number }
  discovery: string[]
  limitations: string[]
  results: Result[]
}
export interface RunOptions extends TransportOptions {
  endpoint: string
  wsEndpoint?: string
  label: string
  version: string
  discover: boolean
  fixtures?: Partial<Fixtures>
  delay: number
  notificationWait: number
  progress?: (result: Result) => void
}

const operational = new Set([-32001, -32004, -32005, -32007, -32009, -32010, -32011, -32012, -32014, -32019])
const universal = new Set([-32700, -32600, -32601, -32602, -32603])

export class Evaluator {
  private validators = new Map<string, ValidateFunction>()
  constructor(private spec: SpecSource) {}

  validate(key: string, schema: any, value: unknown): string | undefined {
    let validate = this.validators.get(key)
    if (!validate) { validate = compileWithComponents(schema, this.spec.schemas); this.validators.set(key, validate) }
    if (validate(value)) return
    return (validate.errors ?? []).slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
  }

  evaluate(method: MethodSource, probe: Probe, response: any): Pick<Result, 'status' | 'detail' | 'code'> {
    if (Object.hasOwn(response, 'error')) {
      const { code } = response.error
      const allowed = (method.yaml.errors ?? []).map((ref: any) => this.spec.errors[ref.$ref.split('/').pop()])
      const definition = allowed.find((e: any) => e?.code === code)
      const errorSchema = definition?.data
      if (errorSchema) {
        const issue = this.validate(`error-${code}`, errorSchema, response.error.data)
        if (issue) return { status: 'fail', code, detail: `Error data violates spec: ${issue}` }
      }
      if (code === -32601) return { status: 'unsupported', code, detail: 'Method not found' }
      if (!definition && !universal.has(code)) return { status: 'fail', code, detail: 'Error code is not declared for this method' }
      if (probe.error === code) {
        if (probe.message && response.error.message !== probe.message) return { status: 'fail', code, detail: 'Error message differs from the normative message' }
        return { status: 'pass', code, detail: 'Expected error code and declared data schema' }
      }
      if (operational.has(code) && definition) return { status: 'inconclusive', code, detail: 'Declared availability, retention, health, or index error; behavior not exercised' }
      if (code === -32603) return { status: 'error', code, detail: 'Server internal error; behavior not exercised' }
      return { status: 'fail', code, detail: probe.error === undefined ? 'Unexpected error for a valid probe' : `Expected error ${probe.error}` }
    }
    if (probe.error !== undefined) return { status: 'fail', detail: `Expected error ${probe.error}, received success` }
    const issue = this.validate(method.name, method.yaml.result.schema, response.result)
    if (issue) return { status: 'fail', detail: `Result schema: ${issue}` }
    const shapeIssue = probe.shape?.(response.result)
    if (shapeIssue) return { status: 'fail', detail: shapeIssue }
    if (probe.nonempty && !probe.nonempty(response.result)) return { status: 'inconclusive', detail: 'Required live data is absent; schema matches but behavior is untested' }
    const semanticIssue = probe.check?.(response.result)
    return semanticIssue ? { status: 'fail', detail: semanticIssue } : { status: 'pass', detail: 'Result schema and probe assertions match' }
  }
}

export async function discoverFixtures(call: Call, fixtures: Fixtures, selected: MethodSource[]): Promise<string[]> {
  const notes: string[] = []
  if (!selected.some((m) => ['getBlock', 'getTransaction', 'getSignaturesForAddress', 'getTokenAccountsByOwner'].includes(m.name))) return notes
  const read = async (method: string, params: unknown[]) => {
    try { return (await call(method, params) as any).result }
    catch { return undefined }
  }
  if (fixtures.slot === undefined) {
    const slot = await read('getSlot', [{ commitment: 'finalized' }])
    if (Number.isSafeInteger(slot) && slot > 64) {
      const blocks = await read('getBlocks', [slot - 64, slot - 32, { commitment: 'finalized' }])
      const candidate = Array.isArray(blocks) ? blocks.find((b) => Number.isSafeInteger(b) && b >= slot - 64 && b <= slot - 32) : slot - 32
      if (Number.isSafeInteger(candidate)) fixtures.slot = candidate
    }
  }
  if (fixtures.slot !== undefined) {
    const block = await read('getBlock', [fixtures.slot, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, rewards: false }])
    if (Array.isArray(block?.transactions)) {
      const tx = block.transactions.find((t: any) => t.transaction?.signatures?.length)
      fixtures.signature ??= tx?.transaction.signatures[0]
      const address = tx?.transaction.message?.accountKeys?.[0]
      fixtures.address ??= typeof address === 'string' ? address : address?.pubkey
      const token = block.transactions.flatMap((t: any) => t.meta?.postTokenBalances ?? []).find((t: any) => t.owner && t.mint && t.programId)
      fixtures.tokenOwner ??= token?.owner
      fixtures.tokenMint ??= token?.mint
      fixtures.tokenProgram ??= token?.programId
      notes.push('Recent ledger fixtures discovered from this target')
    } else notes.push('Recent block discovery unavailable; ledger probes may be inconclusive')
  } else notes.push('No slot discovered; supply a slot fixture for ledger coverage')
  if (!fixtures.tokenOwner) notes.push('No token owner discovered; populated token queries need a fixture')
  return notes
}

export async function run(spec: SpecSource, selected: MethodSource[], options: RunOptions): Promise<Report> {
  const started = Date.now()
  const fixtures = { ...initialFixtures(), ...options.fixtures }
  const results: Result[] = []
  const evaluator = new Evaluator(spec)
  const baseCall = httpTransport(options.endpoint, options)
  const http: Call = async (method, params) => {
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
    return baseCall(method, params)
  }
  const discovery = options.discover ? await discoverFixtures(http, fixtures, selected) : ['Automatic fixture discovery disabled']
  const record = (method: MethodSource, probe: string, result: Pick<Result, 'status' | 'detail'> & Partial<Result>) => {
    const entry: Result = {
      method: method.name, category: category(method), transport: method.transport, probe,
      source: `methods/${method.transport}/${method.name}.md`, durationMs: 0, ...result,
    }
    results.push(entry)
    options.progress?.(entry)
  }
  const execute = async (method: MethodSource, probe: Probe, call: Call): Promise<any> => {
    if (probe.skip) { record(method, probe.name, { status: 'skipped', detail: probe.skip }); return }
    const start = Date.now()
    try {
      const response = await call(method.name, probe.params)
      record(method, probe.name, { ...evaluator.evaluate(method, probe, response), durationMs: Date.now() - start })
      return response
    } catch (error) {
      record(method, probe.name, { status: error instanceof ProtocolError ? 'fail' : 'error', detail: safeError(error), durationMs: Date.now() - start })
    }
  }
  for (const method of selected.filter((m) => m.transport === 'http')) {
    for (const probe of probes(method, fixtures)) await execute(method, probe, http)
  }

  const wsMethods = selected.filter((m) => m.transport === 'websocket')
  if (wsMethods.length && !options.wsEndpoint) {
    for (const method of wsMethods) record(method, 'coverage', { status: 'skipped', detail: 'Provide --ws-endpoint to test WebSocket behavior' })
  } else if (wsMethods.length) {
    const socket = new SocketTransport(options.wsEndpoint!, options)
    try {
      await socket.open()
      const subscribe = spec.methods.find((m) => m.name === 'accountSubscribe')
      const unsubscribe = spec.methods.find((m) => m.name === 'accountUnsubscribe')
      const testSubscribe = wsMethods.some((m) => m.name === 'accountSubscribe')
      const testUnsubscribe = wsMethods.some((m) => m.name === 'accountUnsubscribe')
      for (const method of wsMethods.filter((m) => !['accountSubscribe', 'accountUnsubscribe'].includes(m.name))) record(method, 'coverage', { status: 'skipped', detail: 'No live WebSocket adapter for this method' })
      if ((testSubscribe || testUnsubscribe) && subscribe && unsubscribe) {
        const params = [CLOCK, { encoding: 'base64', commitment: 'processed', dataSlice: { offset: 0, length: 0 }, minContextSlot: Number.MAX_SAFE_INTEGER }]
        const response: any = testSubscribe
          ? await execute(subscribe, { name: 'subscribe', params }, socket.call)
          : await socket.call(subscribe.name, params)
        const id = response?.result
        if (Number.isSafeInteger(id) && id >= 0) {
          if (testSubscribe) {
            await execute(subscribe, { name: 'deduplication', params, check: (r) => r === id ? undefined : 'Identical subscription must return the same id' }, socket.call)
            const notifications: any[] = await socket.observe(options.notificationWait)
            if (!notifications.length) record(subscribe, 'notification', { status: 'inconclusive', detail: 'No account notification observed during the bounded window' })
            else {
              const issue = notifications.map((n) => {
                if (n?.jsonrpc !== '2.0' || n.method !== subscribe.yaml.notification.name || Object.hasOwn(n, 'id') || n.params?.subscription !== id) return 'Invalid notification envelope or subscription id'
                const schemaIssue = evaluator.validate('accountNotification', subscribe.yaml.notification.schema, n.params)
                if (schemaIssue) return `Notification schema: ${schemaIssue}`
                const data = n.params.result.value.data
                if (!Array.isArray(data) || data[1] !== 'base64' || Buffer.from(data[0], 'base64').length !== 40) return 'Clock notification must contain full base64 data; dataSlice is ignored'
              }).find(Boolean)
              record(subscribe, 'notification', { status: issue ? 'fail' : 'pass', detail: issue ?? 'Notification schema, subscription id, encoding, and unsliced data match' })
            }
            await execute(subscribe, { name: 'invalid-pubkey', params: ['bad!'], error: -32602 }, socket.call)
          }
          if (testUnsubscribe) {
            await execute(unsubscribe, { name: 'unsubscribe', params: [id], check: (r) => r === true ? undefined : 'Unsubscribe must return true' }, socket.call)
            await execute(unsubscribe, { name: 'unknown-id', params: [id], error: -32602, message: 'Invalid subscription id.' }, socket.call)
          }
        } else if (testUnsubscribe) record(unsubscribe, 'unsubscribe', { status: 'inconclusive', detail: 'Could not establish prerequisite subscription' })
      } else {
        for (const method of wsMethods.filter((m) => ['accountSubscribe', 'accountUnsubscribe'].includes(m.name))) record(method, 'coverage', { status: 'skipped', detail: 'Spec must contain both accountSubscribe and accountUnsubscribe' })
      }
    } catch (error) {
      for (const method of wsMethods) record(method, 'websocket-session', { status: error instanceof ProtocolError ? 'fail' : 'error', detail: safeError(error) })
    } finally { socket.close() }
  }
  const summary: Record<Status, number> = { pass: 0, fail: 0, unsupported: 0, inconclusive: 0, error: 0, skipped: 0 }
  for (const result of results) summary[result.status]++
  return {
    formatVersion: 1, target: options.label, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    spec: { version: options.version, sha256: createHash('sha256').update(JSON.stringify({ methods: spec.methods.map((m) => ({ name: m.name, transport: m.transport, yaml: m.yaml, md: m.md })), schemas: spec.schemas, errors: spec.errors })).digest('hex') },
    scope: selected.map((m) => m.name), summary,
    coverage: {
      selectedMethods: selected.length,
      methodsWithPass: new Set(results.filter((r) => r.status === 'pass').map((r) => r.method)).size,
      methodsWithGaps: new Set(results.filter((r) => ['skipped', 'inconclusive', 'error'].includes(r.status)).map((r) => r.method)).size,
    },
    discovery,
    limitations: [
      'This is sampled schema and behavior coverage, not proof of full specification conformance.',
      'Only explicitly implemented probes execute. New methods appear as skipped until an adapter is added.',
      'Forks, retention boundaries, every error path, transaction version gating, and all filter combinations are not exhaustively tested.',
      'Error message text is checked only where a probe declares a normative message. Server error data is checked when the spec declares its schema.',
      'JSON numbers use JavaScript number precision; integers above 2^53 cannot be compared exactly.',
      'Reports omit endpoint URLs, headers, request fixtures, raw responses, and server error text. Target labels are user supplied.',
    ], results,
  }
}

function safeError(error: unknown): string {
  if (error instanceof ProtocolError) return error.message
  if (error instanceof Error && ['HTTP connection failed', 'Request timed out', 'Response exceeds configured byte limit', 'WebSocket connection failed', 'WebSocket closed', 'WebSocket request timed out', 'WebSocket send failed', 'WebSocket notification buffer limit reached'].includes(error.message)) return error.message
  if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) return error.message
  return 'Probe execution failed'
}

export function exitCode(report: Report): number {
  if (report.summary.fail || report.summary.unsupported) return 1
  if (report.summary.error || report.summary.skipped || report.summary.inconclusive) return 2
  return 0
}
