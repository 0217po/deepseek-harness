/** Compile-only consumer checks against ordinary generated declarations, without source aliases. */

import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
import type { RemoteResult, RemoteStreamHandle, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { PageArguments, PageOutput } from './client.ts'

declare const remote: TypertClientRemote
declare const input: PageArguments
declare const output: PageOutput
const unary: Promise<RemoteResult<PageOutput>> = TYPERT_REMOTE.methods['session/page'].invoke(remote, input)
const more: boolean = output.hasMore
const records: readonly object[] = output.records
// @ts-expect-error Page arguments retain the generated request fields.
void TYPERT_REMOTE.methods['session/page'].invoke(remote, { request: { throughSeq: 'bad' } })
// @ts-expect-error Page output has no cursor; the follow snapshot supplies it.
void output.cursor
// @ts-expect-error Method info is the descriptor, not a metadata wrapper.
void TYPERT_REMOTE.methods['session/page'].metadata

type Follow = typeof TYPERT_REMOTE.methods['session/follow']
declare const followInput: Parameters<Follow['invoke']>[1]
type FollowOutput = ReturnType<ReturnType<Follow['result']['create']>['parse']>
const stream: RemoteStreamHandle<FollowOutput, never> = TYPERT_REMOTE.methods['session/follow'].invoke(remote, followInput)
stream.end()
stream.dispose()
// @ts-expect-error Follow has no uplink messages.
stream.send({})
void [unary, more, records]
