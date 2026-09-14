import { randomBytes } from 'node:crypto'
import type { MethodSource } from '../loader.js'

export const CLOCK = 'SysvarC1ock11111111111111111111111111111111'
export const SYSVAR = 'Sysvar1111111111111111111111111111111111111'
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const MINT = 'So11111111111111111111111111111111111111112'
export const FUTURE = Number.MAX_SAFE_INTEGER

export function base58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = BigInt('0x' + Buffer.from(bytes).toString('hex'))
  let result = ''
  while (number) { result = alphabet[Number(number % 58n)] + result; number /= 58n }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result }
  return result
}

export interface Fixtures {
  account: string
  missingAccount: string
  missingSignature: string
  slot?: number
  signature?: string
  address?: string
  tokenOwner?: string
  tokenMint?: string
  tokenProgram?: string
}

export function initialFixtures(): Fixtures {
  return { account: CLOCK, missingAccount: base58(randomBytes(32)), missingSignature: base58(randomBytes(64)) }
}

export interface Probe {
  name: string
  params: unknown[]
  error?: number
  message?: string
  skip?: string
  shape?: (result: any) => string | undefined
  check?: (result: any) => string | undefined
  nonempty?: (result: any) => boolean
}

const groups: Record<string, string[]> = {
  Accounts: ['getAccountInfo', 'getBalance', 'getMultipleAccounts', 'getProgramAccounts'],
  Tokens: ['getTokenAccountsByOwner', 'getTokenAccountsByDelegate', 'getTokenAccountsByMint', 'getTokenAccountBalance', 'getTokenLargestAccounts', 'getTokenSupply'],
  Ledger: ['getSlot', 'getBlockHeight', 'getBlock', 'getBlockTime', 'getBlocks', 'getBlocksWithLimit', 'getFirstAvailableBlock', 'minimumLedgerSlot', 'getLatestBlockhash', 'isBlockhashValid', 'getTransaction', 'getSignaturesForAddress', 'getSignatureStatuses', 'getTransactionCount', 'getTransactionSlot', 'getTransactionsForAddress'],
  Transactions: ['sendTransaction', 'simulateTransaction'],
  Cluster: ['getHealth', 'getVersion', 'getIdentity', 'getGenesisHash', 'getClusterNodes', 'getEpochInfo', 'getEpochSchedule', 'getVoteAccounts'],
}

export function category(method: MethodSource): string {
  if (method.transport === 'websocket') return 'Subscriptions'
  return Object.entries(groups).find(([, names]) => names.includes(method.name))?.[0] ?? 'Other'
}

export function selectMethods(methods: MethodSource[], categories: string[], names: string[]): MethodSource[] {
  const available = new Set([...Object.keys(groups), 'Subscriptions', 'Other'].map((v) => v.toLowerCase()))
  for (const c of categories) if (!available.has(c.toLowerCase())) throw new Error(`Unknown category: ${c}`)
  for (const n of names) if (!methods.some((m) => m.name === n)) throw new Error(`Unknown method: ${n}`)
  return methods.filter((m) => (!categories.length || categories.some((c) => c.toLowerCase() === category(m).toLowerCase())) && (!names.length || names.includes(m.name)))
}

function encodingCheck(data: any, encoding: string): string | undefined {
  if (encoding === 'binary') return typeof data === 'string' ? undefined : 'Expected legacy bare base58 string'
  if (encoding === 'jsonParsed') return !Array.isArray(data) || data[1] === 'base64' ? undefined : 'jsonParsed fallback must use base64'
  return Array.isArray(data) && data[1] === encoding ? undefined : `Expected ${encoding} tuple`
}

function accountCheck(result: any, encoding: string, sliced = false): string | undefined {
  const error = encodingCheck(result.value.data, encoding)
  if (error) return error
  if (sliced && result.value.data[0] !== '') return 'Zero-length dataSlice must return empty data'
}

export function probes(method: MethodSource, f: Fixtures): Probe[] {
  const cases: Probe[] = []
  const add = (name: string, params: unknown[], rest: Partial<Probe> = {}) => cases.push({ name, params, ...rest })
  const present = (r: any) => r.value !== null
  const blockFixture = f.slot === undefined ? 'No recent readable block; provide a slot fixture' : undefined
  const txFixture = !f.signature ? 'No recent transaction; provide a signature fixture' : undefined
  switch (method.name) {
    case 'getAccountInfo':
      for (const encoding of ['binary', 'base58', 'base64', 'base64+zstd', 'jsonParsed']) {
        add(`encoding-${encoding}`, [f.account, { encoding }], { nonempty: present, check: (r) => accountCheck(r, encoding) })
      }
      add('default-encoding', [f.account], { nonempty: present, check: (r) => accountCheck(r, 'binary') })
      add('data-slice', [f.account, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }], { nonempty: present, check: (r) => accountCheck(r, 'base64', true) })
      add('missing-account', [f.missingAccount], { check: (r) => r.value === null ? undefined : 'Missing account must return value: null' })
      break
    case 'getBalance':
      add('existing-account', [f.account])
      add('missing-account', [f.missingAccount], { check: (r) => r.value === 0 ? undefined : 'Missing account balance must be zero' })
      break
    case 'getMultipleAccounts':
      add('order-duplicates-and-null', [[f.account, f.missingAccount, f.account]], {
        shape: (r) => r.value.length === 3 && r.value[1] === null && JSON.stringify(r.value[0]) === JSON.stringify(r.value[2]) ? undefined : 'Result must preserve order, duplicates, and null entries',
        nonempty: (r) => r.value[0] !== null,
      })
      for (const encoding of ['base64', 'base58', 'jsonParsed']) add(`encoding-${encoding}`, [[f.account], { encoding }], {
        nonempty: (r) => r.value[0] != null,
        check: (r) => encodingCheck(r.value[0].data, encoding),
      })
      add('default-encoding', [[f.account]], { nonempty: (r) => r.value[0] != null, check: (r) => encodingCheck(r.value[0].data, 'base64') })
      add('empty-list', [[]], { check: (r) => r.value.length === 0 ? undefined : 'Empty input must produce empty value' })
      break
    case 'getProgramAccounts': {
      const program = f.tokenOwner ? f.tokenProgram ?? TOKEN : SYSVAR
      const filters = f.tokenOwner ? [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: f.tokenOwner } }] : [{ dataSize: 40 }]
      for (const withContext of [false, true]) add(`withContext-${withContext}`, [program, { encoding: 'base64', filters, withContext, dataSlice: { offset: 0, length: 0 } }], {
        shape: (r) => Array.isArray(r) === withContext ? 'Result does not match requested withContext' : undefined,
        check: (r) => {
          const accounts = withContext ? r.value : r
          if (accounts.some((a: any) => a.account.owner !== program || a.account.data[0] !== '')) return 'Program ownership or zero-length dataSlice violated'
          if (accounts.some((a: any) => a.account.space != null && a.account.space !== (f.tokenOwner ? 165 : 40))) return 'dataSize filter violated'
        },
        nonempty: (r) => (Array.isArray(r) ? r : r.value).length > 0,
      })
      add('too-many-filters', [program, { filters: Array.from({ length: 5 }, () => ({ dataSize: 40 })) }], { error: -32602 })
      break
    }
    case 'getTokenAccountsByOwner':
      add('empty-owner', [f.missingAccount, { programId: TOKEN }, { encoding: 'base64' }], { check: (r) => r.value.length === 0 ? undefined : 'Random owner should have no token accounts' })
      for (const filter of [{ programId: f.tokenProgram ?? TOKEN }, { mint: f.tokenMint ?? MINT }]) add(`owner-by-${Object.keys(filter)[0]}`, [f.tokenOwner ?? f.missingAccount, filter, { encoding: 'jsonParsed' }], {
        skip: !f.tokenOwner || ('mint' in filter && !f.tokenMint) ? 'Provide tokenOwner and tokenMint fixtures for populated token queries' : undefined,
        nonempty: (r) => r.value.length > 0,
        check: (r) => r.value.some((a: any) => a.account.data.parsed?.info?.owner !== f.tokenOwner || ('mint' in filter && a.account.data.parsed?.info?.mint !== filter.mint)) ? 'Parsed token owner or mint does not match filter' : undefined,
      })
      add('invalid-token-program', [f.missingAccount, { programId: f.account }], { error: -32602 })
      add('ambiguous-filter', [f.missingAccount, { mint: MINT, programId: TOKEN }], { error: -32602 })
      add('empty-filter', [f.missingAccount, {}], { error: -32602 })
      break
    case 'getSlot': case 'getBlockHeight': case 'getLatestBlockhash':
      add('default', [])
      for (const commitment of ['processed', 'confirmed', 'finalized']) add(`commitment-${commitment}`, [{ commitment }])
      break
    case 'getHealth': add('health', []); break
    case 'getBlock':
      for (const details of ['none', 'signatures', 'accounts', 'full']) for (const rewards of [true, false]) add(`details-${details}-rewards-${rewards}`, [f.slot ?? 0, { transactionDetails: details, rewards, maxSupportedTransactionVersion: 0 }], {
        skip: blockFixture, nonempty: (r) => r !== null,
        check: (r) => {
          if (Object.hasOwn(r, 'rewards') !== rewards) return 'rewards presence does not match config'
          if (Object.hasOwn(r, 'transactions') !== ['full', 'accounts'].includes(details)) return 'transactions presence does not match transactionDetails'
          if (Object.hasOwn(r, 'signatures') !== (details === 'signatures')) return 'signatures presence does not match transactionDetails'
          if (details === 'accounts' && r.transactions.some((t: any) => t.transaction.message !== undefined)) return 'accounts detail must omit transaction message'
        },
      })
      for (const encoding of ['base64', 'base58', 'jsonParsed']) add(`encoding-${encoding}`, [f.slot ?? 0, { encoding, rewards: false, maxSupportedTransactionVersion: 0 }], {
        skip: blockFixture, nonempty: (r) => r?.transactions?.length > 0,
        check: (r) => r.transactions.map((t: any) => transactionEncoding(t, encoding)).find(Boolean),
      })
      add('processed-rejected', [f.slot ?? 0, { commitment: 'processed' }], { error: -32602 })
      break
    case 'getTransaction':
      for (const encoding of ['json', 'jsonParsed', 'base58', 'base64', 'binary']) add(`encoding-${encoding}`, [f.signature ?? f.missingSignature, { encoding, maxSupportedTransactionVersion: 0 }], {
        skip: txFixture, nonempty: (r) => r !== null, check: (r) => transactionEncoding(r, encoding),
      })
      add('not-found', [f.missingSignature, { maxSupportedTransactionVersion: 0 }], { check: (r) => r === null ? undefined : 'Unknown signature must return null' })
      add('processed-rejected', [f.missingSignature, { commitment: 'processed' }], { error: -32602 })
      break
    case 'getSignaturesForAddress':
      add('limited-history', [f.address ?? f.account, { limit: 5 }], {
        nonempty: (r) => r.length > 0,
        check: (r) => r.length > 5 || r.some((v: any, i: number) => i > 0 && v.slot > r[i - 1].slot) ? 'History exceeds limit or is not newest first' : undefined,
      })
      for (const limit of [0, 1001]) add(`invalid-limit-${limit}`, [f.account, { limit }], { error: -32602 })
      add('processed-rejected', [f.account, { commitment: 'processed' }], { error: -32602 })
      add('missing-cursor', [f.address ?? f.account, { before: f.missingSignature, limit: 1 }], { error: -32020 })
      break
    default:
      return [{ name: 'coverage', params: [], skip: 'No live probe adapter for this method' }]
  }
  const params = method.yaml.params ?? []
  if (params.some((p: any) => p.required)) add('missing-required-params', [], { error: -32602 })
  const first = params[0]
  if (first?.schema?.$ref?.endsWith('/Pubkey') || first?.schema?.$ref?.endsWith('/Signature')) {
    const baseline = cases.find((c) => c.error === undefined)?.params ?? []
    add('invalid-base58', ['not-a-base58-key!', ...baseline.slice(1)], { error: -32602 })
  }
  if ((method.yaml.errors ?? []).some((e: any) => e.$ref.endsWith('/MinContextSlotNotReached'))) {
    const baseline = cases.find((c) => c.error === undefined)?.params ?? []
    const index = params.findIndex((p: any) => p.name === 'config')
    const futureParams = structuredClone(baseline)
    futureParams[index] = { ...(futureParams[index] as object ?? {}), minContextSlot: FUTURE }
    add('min-context-slot', futureParams, { error: -32016, message: 'Minimum context slot has not been reached' })
    if (method.name === 'getProgramAccounts') {
      const withContextParams = structuredClone(futureParams)
      withContextParams[index] = { ...(withContextParams[index] as object), withContext: true }
      add('min-context-slot-with-context', withContextParams, { error: -32016, message: 'Minimum context slot has not been reached' })
    }
  }
  return cases
}

function transactionEncoding(result: any, encoding: string): string | undefined {
  const tx = result.transaction
  if (['base64', 'base58', 'binary'].includes(encoding)) return encodingCheck(tx, encoding)
  if (Array.isArray(tx) || !tx?.message) return 'Expected JSON transaction with message'
  const keys = tx.message.accountKeys
  if (keys.some((key: any) => typeof key !== (encoding === 'jsonParsed' ? 'object' : 'string'))) return 'Account keys do not match requested transaction encoding'
  if (encoding === 'jsonParsed' && result.meta && Object.hasOwn(result.meta, 'loadedAddresses')) return 'jsonParsed must omit meta.loadedAddresses'
}
