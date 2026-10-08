/** Scoped bundles use real preset generations, profile reloads, and package-removal admission. */
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, initProfile, PluginPackages, readProfileManifest, readProfilePatches, createRuntimeResolution, loadProfileDirectory, type ProfileContext, type ProfilePatch } from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionTitle, { SessionTitleProviderId, type SessionTitleProviderRequest, type SessionTitleProviderResult } from '@deepseek-ai/dsh-session-title'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import PluginManager from '../src/index.ts'
import * as operations from '../src/operations.ts'
import * as appBoot from '@deepseek-ai/dsh-app-boot'

async function fixture(options: { title?: boolean; hmr?: boolean; presets?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'preset-bundle-'))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"test-installation","dependencies":{}}\n')
  initProfile(dir, ['core'])
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const bundle = (name: string, patches: ProfilePatch[]): string => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), JSON.stringify(patches))
    writeFileSync(join(path, 'plugin.mjs'), 'export function apply(ctx, config) { if (config?.fail) throw new Error("scoped plugin failed"); ctx.get("scopedBundleTrace").push("start"); ctx.effect(() => () => { ctx.get("scopedBundleTrace").push("stop") }) }\n')
    return path
  }
  bundle('core', [{ insert: [
    { id: 'manager', name: 'cordis:manager' },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'session-projections', name: 'cordis:session-projections' },
    { id: 'presets', name: 'cordis:presets', config: { default: 'standard' } },
    ...(options.presets === false ? [] : ['standard', 'cordis']).map(id => ({ id: `preset-${id}`, name: 'cordis:preset', config: { id, plugins: [] } })),
    ...options.title === true ? [
      { id: 'title', name: 'cordis:title', config: { fallbackMaxWords: 5, fallbackMaxBytes: 100, maxTitleBytes: 100 } },
      { id: 'default-title', name: 'cordis:title-provider', config: { id: 'default' } },
    ] : [],
  ] }])
  const addon = bundle('addon', ['standard', 'cordis'].map(preset => ({ preset: `preset-${preset}`, insert: [{
    id: 'shared-id', name: './plugin.mjs',
  }] })))
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { addon: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const profile: ProfileContext = {
    name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor,
    cwd: home, home, startedBundles: ['core'], overlays: [], telemetryDisabledEnv: undefined,
  }
  const resolution = await createRuntimeResolution({ installAnchor: anchor, profile: loadProfileDirectory('test', dir, anchor), home })
  const calls: {
    id: string
    request: SessionTitleProviderRequest
    pending: ReturnType<typeof Promise.withResolvers<SessionTitleProviderResult>>
  }[] = []
  const entered: { current: ReturnType<typeof Promise.withResolvers<undefined>> } = { current: Promise.withResolvers<undefined>() }
  const trace: string[] = []
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), async (host) => {
    owner = host
    host.provide('profileContext', profile)
    host.provide('scopedBundleTrace', trace)
    host.provide('appReady', { onReady(listener) { listener(); return () => {} } })
    Object.assign(host.loader.builtins, {
      manager: PluginManager, sessions: SessionStore, 'session-projections': SessionProjections,
      presets: AgentPresets, preset: AgentPreset, title: SessionTitle,
      'title-provider': {
        inject: ['sessionTitle'],
        apply(ctx: Context, config: { id: string }) {
          ctx.sessionTitle.register({
            id: SessionTitleProviderId(config.id), automatic: 'all-prompts',
            generate(request) {
              const pending = Promise.withResolvers<SessionTitleProviderResult>()
              calls.push({ id: config.id, request, pending })
              entered.current.resolve(undefined)
              return pending.promise
            },
          })
        },
      },
    })
    await host.plugin(PluginPackages, { resolution })
  })
  await ctx.plugin(Timer)
  if (options.hmr !== false) {
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
  }
  onTestFinished(() => {
    for (const call of calls) call.pending.resolve({ title: 'teardown', messageSeqs: call.request.messages.map(message => message.seq) })
  })
  return { ctx, manager: ctx.pluginManager, profile, dir, addon, bundle, trace, calls, entered }
}

it('lists scoped declarations while Off and keeps equal inner ids distinct across presets', async () => {
  const { manager, addon } = await fixture()
  const patchFile = join(addon, 'cordis.patch.yml')
  const patches = JSON.parse(readFileSync(patchFile, 'utf8')) as ProfilePatch[]
  writeFileSync(patchFile, JSON.stringify([...patches,
    { id: 'shared-id', disabled: true },
    { preset: 'preset-standard', id: 'absent', disabled: true },
  ]))
  const moduleName = pathToFileURL(join(addon, 'plugin.mjs')).href
  expect((await manager.listBundles()).find(row => row.name === 'addon')?.rows).toEqual([
    { rowId: 'shared-id', preset: 'preset-standard', readOnlyReason: 'preset-managed', moduleName },
    { rowId: 'shared-id', preset: 'preset-cordis', readOnlyReason: 'preset-managed', moduleName },
  ])
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied', changed: true })
  const enabled = (await manager.listBundles()).find(row => row.name === 'addon')!
  expect(enabled.rows).toEqual([
    { rowId: 'shared-id', preset: 'preset-standard', readOnlyReason: 'preset-managed', moduleName, composition: { enabled: true, fiberPhase: 'active' } },
    { rowId: 'shared-id', preset: 'preset-cordis', readOnlyReason: 'preset-managed', moduleName, composition: { enabled: true, fiberPhase: 'active' } },
  ])
  expect(enabled.rows.every(row => row.entryId === undefined)).toBe(true)
  expect(enabled.overrides).toEqual(['shared-id', 'preset-standard/absent'])
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === 'addon')?.rows.every(row => row.composition === undefined)).toBe(true)
})

it('loads a third-party relative child inside a real preset group and retains its package until release', async () => {
  const { manager, ctx, dir, addon, bundle, trace } = await fixture()
  bundle('addon', [{ preset: 'preset-standard', insert: [{
    id: 'relative-group', name: 'cordis:group', group: true, config: [{
      id: 'relative-child', name: './nested/relative.mjs', config: { value: 'nested-preset' },
    }],
  }] }])
  mkdirSync(join(addon, 'nested'))
  writeFileSync(join(addon, 'nested/relative.mjs'), [
    'export function apply(ctx, config) {',
    '  ctx.get("scopedBundleTrace").push(`relative:start:${config.value}`)',
    '  ctx.effect(() => () => { ctx.get("scopedBundleTrace").push("relative:stop") })',
    '}',
    '',
  ].join('\n'))
  const moduleName = pathToFileURL(join(addon, 'nested/relative.mjs')).href
  const declared = (await manager.listBundles()).find(row => row.name === 'addon')?.rows
    .find(row => row.rowId === 'relative-child')
  expect(declared).toEqual({ rowId: 'relative-child', preset: 'preset-standard', readOnlyReason: 'preset-managed', moduleName })
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied' })
  expect(trace).toEqual(['relative:start:nested-preset'])
  expect((await ctx.agentPresets.compositionInventory()).find(preset => preset.id === 'standard')?.rows)
    .toMatchObject([{ entryId: 'relative-child', moduleName, enabled: true }])

  const owner = createScope(ctx, {})
  onTestFinished(() => owner.dispose())
  await ctx.agentPresets.mount(owner.ctx, 'standard')
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied' })
  expect(ctx.agentPresets.inspectCompositions(owner.ctx)[0]?.modules).toMatchObject([{ moduleName }])
  expect(trace).toEqual(['relative:start:nested-preset'])
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.addon
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'remove.log') }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'failed', error: { code: 'bundle-in-use' } })
  expect(remove).not.toHaveBeenCalled()
  await owner.dispose()
  expect(trace).toEqual(['relative:start:nested-preset', 'relative:stop'])
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'applied', changed: true })
  expect(remove).toHaveBeenCalledOnce()
})

it('retains a failed selection, reports affected preset failures again, and keeps unrelated failures as warnings', async () => {
  const { manager, dir, bundle, ctx } = await fixture()
  bundle('broken', [{ preset: 'preset-standard', insert: [{ id: 'broken', name: './plugin.mjs', config: { fail: true } }] }])
  const result = await manager.setBundleEnabled('broken', true)
  expect(result).toMatchObject({ application: 'failed', changed: true, error: { diagnostic: expect.stringContaining('agent preset standard') as string } })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toContain('broken')
  expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed', changed: false })
  expect((await ctx.agentPresets.list()).find(row => row.id === 'standard')?.broken).toContain('scoped plugin failed')
  bundle('unrelated', [{ insert: [{ id: 'unrelated', name: './plugin.mjs' }] }])
  expect(await manager.setBundleEnabled('unrelated', true)).toMatchObject({ application: 'applied', warnings: [expect.stringContaining('agent preset standard')] })
  expect(await manager.setBundleEnabled('broken', false)).toMatchObject({ application: 'applied' })
  expect((await ctx.agentPresets.list()).every(row => row.broken === undefined)).toBe(true)
})

it('refuses a no-op scoped enable when its Host preset row already failed before registering', async () => {
  const { manager, ctx, bundle, dir } = await fixture()
  bundle('invalid-definition', [{ id: 'preset-standard', config: { id: '', plugins: [] } }])
  expect(await manager.setBundleEnabled('invalid-definition', true)).toMatchObject({ application: 'failed' })
  expect((await ctx.agentPresets.list()).map(row => row.id)).not.toContain('standard')
  bundle('scoped-noop', [{ preset: 'preset-standard', insert: [] }])
  expect(await manager.setBundleEnabled('scoped-noop', true)).toMatchObject({
    application: 'failed', changed: true, error: { diagnostic: expect.stringContaining('Preset id must not be empty') as string },
  })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toContain('scoped-noop')
})

it.each([{ id: 'standard' }, { id: 'standard', plugins: [] }])(
  'keeps existing preset failures as warnings when an unrelated Host config is %j', async (config) => {
    const { manager, bundle, ctx } = await fixture()
    expect(await ctx.agentPresets.list()).toMatchObject([{ id: 'cordis', definitionEntryId: 'preset-cordis' }, { id: 'standard', definitionEntryId: 'preset-standard' }])
    expect((await ctx.agentPresets.remoteExportList()).presets.every(row => !Object.hasOwn(row, 'definitionEntryId'))).toBe(true)
    bundle('broken', [{ preset: 'preset-standard', insert: [{ id: 'broken', name: './plugin.mjs', config: { fail: true } }] }])
    expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed' })
    bundle('ordinary', [{ insert: [{ id: 'ordinary', name: './plugin.mjs', config }] }])
    expect(await manager.setBundleEnabled('ordinary', true)).toMatchObject({
      application: 'applied', warnings: [expect.stringContaining('agent preset standard')],
    })
  },
)

it('reports invalid composition immediately without HMR while retaining the saved selection', async () => {
  const { manager, dir } = await fixture({ hmr: false, presets: false })
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({
    application: 'failed', changed: true, error: { diagnostic: expect.stringContaining(join('addon', 'cordis.patch.yml')) as string },
  })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toContain('addon')
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'restart-required', changed: true })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).not.toContain('addon')
})

it('refuses Remove after Off while an old Agent scope retains the bundle, then removes after release', async () => {
  const { manager, ctx, dir, trace } = await fixture()
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied' })
  const agent = createScope(ctx, {})
  onTestFinished(() => agent.dispose())
  await ctx.agentPresets.mount(agent.ctx, 'standard')
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied' })
  expect(ctx.agentPresets.inspectCompositions(agent.ctx)[0]?.modules).toHaveLength(1)
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.addon
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'remove.log') }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'failed', error: { code: 'bundle-in-use' }, changed: false })
  expect(remove).not.toHaveBeenCalled()
  await agent.dispose()
  expect(trace.filter(item => item === 'stop')).toHaveLength(2)
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'applied', changed: true })
  expect(remove).toHaveBeenCalledOnce()
})

it.each([false, true].flatMap(anonymous => [false, true].map(archive => ({ anonymous, archive }))))
('removes a released contribution while base presets keep using the same shared module (anonymous=$anonymous, archive=$archive)', async ({ anonymous, archive }) => {
  // Resolver identities must be created under the same carrier that later refreshes them.
  if (archive) {
    const previousPkg = Object.getOwnPropertyDescriptor(process, 'pkg')
    onTestFinished(() => {
      if (previousPkg === undefined) Reflect.deleteProperty(process, 'pkg')
      else Object.defineProperty(process, 'pkg', previousPkg)
    })
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
  }
  const { manager, ctx, dir, addon } = await fixture()
  const shared = join(dir, 'node_modules', 'shared-fixture')
  mkdirSync(shared)
  writeFileSync(join(shared, 'package.json'), JSON.stringify({ name: 'shared-fixture', version: '1.0.0', type: 'module', exports: './index.mjs' }))
  writeFileSync(join(shared, 'index.mjs'), 'export function apply() {}\n')
  const core = join(dir, 'node_modules', 'core')
  const corePatches = JSON.parse(readFileSync(join(core, 'cordis.patch.yml'), 'utf8')) as ProfilePatch[]
  for (const row of corePatches[0]!.insert!) {
    if (row.id === 'preset-standard') row.config = { id: 'standard', plugins: [{ id: 'base-shared', name: 'shared-fixture' }] }
    if (row.id === 'preset-cordis') row.config = { id: 'cordis', plugins: [{ id: 'addon-shared', name: 'shared-fixture' }] }
  }
  writeFileSync(join(core, 'cordis.patch.yml'), JSON.stringify(corePatches))
  writeFileSync(join(addon, 'cordis.patch.yml'), JSON.stringify([{
    preset: 'preset-standard', insert: [{ ...anonymous ? {} : { id: 'addon-shared' }, name: 'shared-fixture' }],
  }]))
  for (const packageDir of [core, addon]) {
    const manifest = readProfileManifest('test', packageDir)
    manifest.dependencies = { 'shared-fixture': '1.0.0' }
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
  }
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied' })
  const owner = createScope(ctx, {})
  onTestFinished(() => owner.dispose())
  await ctx.agentPresets.mount(owner.ctx, 'standard')
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied' })
  expect(ctx.agentPresets.inspectCompositions(owner.ctx)).toMatchObject([{
    id: 'standard', definitionEntryId: 'preset-standard', modules: [
      { entryId: 'base-shared', moduleName: 'shared-fixture' },
      { entryId: anonymous ? expect.any(String) as string : 'addon-shared', moduleName: 'shared-fixture' },
    ],
  }])
  if (archive) {
    const original = fs.realpathSync
    onTestFinished(() => { fs.realpathSync = original; syncBuiltinESMExports() })
    fs.realpathSync = new Proxy(original, {
      apply(target, receiver: unknown, args: unknown[]): unknown {
        if (['package.json', 'index.mjs'].some(file => String(args[0]).endsWith(join('shared-fixture', file)))) {
          throw Object.assign(new Error('archive-backed files have no realpath entry'), { code: 'ENOENT' })
        }
        return Reflect.apply(target, receiver, args)
      },
    })
    syncBuiltinESMExports()
    expect(() => fs.realpathSync(join(shared, 'package.json'))).toThrow('archive-backed')
    expect(readFileSync(join(shared, 'index.mjs'), 'utf8')).toContain('export function apply')
  }
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.addon
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'remove.log') }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'failed', error: { code: 'bundle-in-use' } })
  expect(remove).not.toHaveBeenCalled()
  await owner.dispose()
  expect(ctx.agentPresets.inspectCompositions().flatMap(preset => preset.modules).map(module => module.moduleName))
    .toEqual(['shared-fixture', 'shared-fixture'])
  const removed = await manager.removeBundle('addon')
  expect(removed, JSON.stringify(removed.error)).toMatchObject({ application: 'applied', changed: true })
  expect(remove).toHaveBeenCalledOnce()
})

it('removes an unrelated bundle when another retained row with the same id has lost its module file', async () => {
  const { manager, ctx, dir, addon, bundle } = await fixture()
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied' })
  const owner = createScope(ctx, {})
  onTestFinished(() => owner.dispose())
  await ctx.agentPresets.mount(owner.ctx, 'standard')
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied' })
  bundle('unrelated', [{ preset: 'preset-standard', insert: [{ id: 'shared-id', name: './plugin.mjs' }] }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, unrelated: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  rmSync(join(addon, 'plugin.mjs'))
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({
    exitCode: 0, output: '', truncated: false, logPath: join(dir, 'remove.log'),
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'failed', error: { code: 'bundle-in-use' } })
  expect(remove).not.toHaveBeenCalled()
  const resolution = vi.spyOn(appBoot, 'resolvePluginResource').mockImplementationOnce(() => { throw new Error('resolver unavailable') })
  onTestFinished(() => { resolution.mockRestore() })
  expect(await manager.removeBundle('unrelated')).toMatchObject({ application: 'failed', error: { diagnostic: 'resolver unavailable' } })
  expect(remove).not.toHaveBeenCalled()
  resolution.mockRestore()
  expect(await manager.removeBundle('unrelated')).toMatchObject({ application: 'applied' })
  expect(remove).toHaveBeenCalledOnce()
  expect(ctx.agentPresets.inspectCompositions(owner.ctx)[0]?.modules).toHaveLength(1)
})

it('retains contributed builtin rows even when no package owns their module names', async () => {
  const { manager, ctx, bundle } = await fixture()
  ctx.loader.builtins['retained-fixture'] = { apply() {} }
  bundle('addon', [{ preset: 'preset-standard', insert: [{ id: 'builtin', name: 'cordis:retained-fixture' }] }])
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied' })
  const agent = createScope(ctx, {})
  onTestFinished(() => agent.dispose())
  await ctx.agentPresets.mount(agent.ctx, 'standard')
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied' })
  const inspect = ctx.agentPresets.inspectCompositions.bind(ctx.agentPresets)
  const projection = vi.spyOn(ctx.agentPresets, 'inspectCompositions').mockImplementation(() => inspect().map(composition => ({
    ...composition, modules: composition.modules.map(({ baseUrl: _baseUrl, ...module }) => module),
  })))
  onTestFinished(() => { projection.mockRestore() })
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'failed', error: { code: 'bundle-in-use' } })
})

it('refuses removal when a different module from the same package remains in a preset', async () => {
  const { manager, ctx, dir, addon } = await fixture()
  const source = readFileSync(join(addon, 'plugin.mjs'), 'utf8')
  writeFileSync(join(addon, 'other.mjs'), source)
  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied' })
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{
    preset: 'preset-standard', insert: [{ id: 'independent', name: pathToFileURL(join(addon, 'other.mjs')).href }],
  }]))
  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied' })
  expect(ctx.agentPresets.inspectCompositions().some(row => row.modules.some(module => module.moduleName.endsWith('/other.mjs')))).toBe(true)
  const remove = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('addon')).toMatchObject({ application: 'failed', error: { code: 'bundle-in-use' } })
  expect(remove).not.toHaveBeenCalled()
})

async function requestTitle(session: Session): Promise<void> {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Title for provider switch' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  session.append('request/header', { header: { config: { provider: 'test', model: 'test' } }, reason: 'initial' })
}

it('drains and rejects stale title completions before activating each replacement in both directions', async () => {
  const { manager, ctx, bundle, calls, entered } = await fixture({ title: true })
  bundle('titles', [
    { id: 'default-title', disabled: true },
    { insert: [{ id: 'optional-title', name: 'cordis:title-provider', config: { id: 'optional' } }] },
  ])
  for (const [enabled, expected] of [[true, 'default'], [false, 'optional']] as const) {
    entered.current = Promise.withResolvers<undefined>()
    const session = ctx.sessions.create(SessionId(`title-switch-${String(enabled)}`))
    await requestTitle(session)
    await entered.current.promise
    const call = calls.at(-1)!
    expect(call.id).toBe(expected)
    const aborted = Promise.withResolvers<undefined>()
    call.request.signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    let complete = false
    const switching = manager.setBundleEnabled('titles', enabled).then((result) => { complete = true; return result })
    onTestFinished(async () => {
      call.pending.resolve({ title: 'teardown', messageSeqs: call.request.messages.map(message => message.seq) })
      await switching
    })
    await aborted.promise
    expect(complete).toBe(false)
    expect(calls).toHaveLength(enabled ? 1 : 2)
    call.pending.resolve({ title: 'stale result', messageSeqs: call.request.messages.map(message => message.seq) })
    expect(await switching).toMatchObject({ application: 'applied' })
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
  }
  entered.current = Promise.withResolvers<undefined>()
  const final = ctx.sessions.create(SessionId('title-switch-final'))
  await requestTitle(final)
  await entered.current.promise
  expect(calls.at(-1)?.id).toBe('default')
  calls.at(-1)?.pending.resolve({ title: 'final title', messageSeqs: calls.at(-1)!.request.messages.map(message => message.seq) })
})
