/** Account-token authentication, the account model listing, and version gating for the DeepSeek account route. */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY, LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekRequestAuth, ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { AccountModelCatalog } from './catalog.ts'
import type { CatalogView } from './catalog.ts'
import { Config, plainAccountOptions, resolveAccountOptions } from './config.ts'
import { requestModelListing } from './listing.ts'
import type { ModelListing } from './listing.ts'
import { resolveAccountCatalog } from './resolve-catalog.ts'
import type { AccountCatalog, CatalogRefusal } from './resolve-catalog.ts'

export { Config } from './config.ts'
export const name = 'llm-deepseek-account'
export const inject = ['llm']

const PROVIDER = 'deepseek-account'
/** Header carrying the account token on Messages, Files, and model-listing requests. */
const TOKEN_HEADER = 'x-dsh-auth-token'

/** Connection facts of one account operation: protocol settings plus the catalog resolved with them. */
interface AccountConnection extends ResolvedDeepSeekOptions {
  readonly catalog: AccountCatalog
}

function refuse(model: string, refusal: CatalogRefusal | undefined): void {
  if (refusal === undefined) return
  switch (refusal.kind) {
    case 'upgrade-required':
      throw new LlmError(
        `DeepSeek model "${model}" requires DeepSeek Harness ${refusal.requiredVersion} or later; this build is ${APP_IDENTITY.version}`,
        'CLIENT_UPGRADE_REQUIRED',
      )
    case 'unsupported':
      throw new LlmError(`DeepSeek model "${model}" is not supported by DeepSeek Harness ${APP_IDENTITY.version}`, 'MODEL_UNSUPPORTED')
    /* v8 ignore next 2 -- catalog resolution produces only the closed refusal union */
    default:
      assertNever(refusal, 'account catalog refusal')
  }
}

export function apply(ctx: Context, config: Config): void {
  const environment = launchEnvironmentOf(ctx)
  const settings = () => resolveAccountOptions(plainAccountOptions(config), environment)
  settings()
  const supported = resolveAdapterOptions({}).models
  const account = () => ctx.get('deepseekAccount')
  const resolveAuth = async (connection: ResolvedDeepSeekOptions): Promise<DeepSeekRequestAuth> => {
    const token = await account()?.resolveToken(connection.baseURL)
    if (token === undefined) throw new LlmError('Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.', 'ACCOUNT_SIGN_IN_REQUIRED')
    return {
      headers: { [TOKEN_HEADER]: token },
      onRequestError: async (error) => {
        if (!(error instanceof LlmError) || error.failure.status !== 401) return error
        const rejected = new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
        try { await account()?.rejectToken(token) }
        catch (_credentialRemovalFailed) { /* Storage failure cannot replace the inference failure. */ }
        return rejected
      },
    }
  }
  const catalog = new AccountModelCatalog({
    settings: () => settings().catalog,
    token: async url => account()?.resolveToken(url),
    load: (url, token, signal) => requestModelListing(url, { [TOKEN_HEADER]: token }, signal),
    now: () => Date.now(),
    warn: (message) => { ctx.logger.warn(message) },
  })
  const connectionOf = (view: CatalogView): AccountConnection => {
    const resolved = settings()
    const result = resolveAccountCatalog({
      listing: view.listing?.entries,
      supported,
      overrides: resolved.modelOverrides,
      routeMaxTokens: resolved.protocol.maxTokens,
      clientVersion: APP_IDENTITY.version,
    })
    return { ...resolved.protocol, models: result.resolution, catalog: result }
  }
  const entry = { provider: PROVIDER, displayName: 'DeepSeek Account', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] }
  const directory = ctx.llm.registerConfigurableProviders([entry])
  let loggedListing: ModelListing | undefined
  let reportedError: string | undefined
  /** Log listing problems once per listing and publish override diagnostics on the provider directory. */
  const discovered = (view: CatalogView): AccountConnection => {
    const connection = connectionOf(view)
    if (view.listing !== loggedListing) {
      loggedListing = view.listing
      for (const problem of connection.catalog.problems) ctx.logger.warn(`llm-deepseek-account: ${problem}`)
    }
    const error = connection.catalog.overrideErrors.length === 0 ? undefined : connection.catalog.overrideErrors.join('; ')
    if (error !== reportedError) {
      reportedError = error
      directory.replace([error === undefined ? entry : { ...entry, error }])
    }
    return connection
  }
  registerDeepSeekProvider<AccountConnection>(ctx, PROVIDER, {
    providerName: 'DeepSeek Account',
    options: () => connectionOf(catalog.current()),
    connect: async signal => connectionOf(await catalog.view(signal)),
    resolveAuth,
    admit: (connection, model) => { refuse(model, connection.catalog.refusals.get(model)) },
    discoverModels: async (provider) => {
      const view = await catalog.view()
      return view.signedIn ? discovered(view).catalog.offered.map(model => catalogModelInfo(provider, model)) : []
    },
  })
  ctx.effect(() => () => { catalog.dispose() }, 'llm-deepseek-account: model catalog')
}
