/** Published direct checker launcher smoke; CI supplies built package exports before this keyless lane. */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(join(packageRoot, 'lib/commands.js'))

it.skipIf(!built)('runs the emitted direct checker launcher and preserves its arguments and exit status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-built-office-'))
  try {
    const runtime = join(root, 'runtime'), assets = join(root, 'assets')
    const python = join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    await mkdir(dirname(python), { recursive: true })
    // The fixture executable speaks the checker's argv/exit protocol; the carrier smoke owns Python libraries.
    if (process.platform === 'win32') await copyFile(process.execPath, python)
    else await symlink(process.execPath, python)
    await mkdir(join(assets, 'scripts'), { recursive: true })
    await writeFile(join(assets, 'scripts/check_office.py'), "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); process.exitCode = 7;\n")
    const script = `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { delimiter, join } from 'node:path';
      import { Context } from '@deepseek-ai/cordis';
      import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
      import * as Commands from '@deepseek-ai/dsh-skill-office/commands';
      import { execa } from 'execa';
      const root = process.argv[1], ctx = new Context();
      try {
        await ctx.plugin(ShellEnv);
        await ctx.plugin(Commands, { command: false, assetRoot: join(root, 'assets') });
        const env = ctx.shellEnv.collect({ signal: new AbortController().signal, token: Symbol(), callId: 'smoke', rootCallId: 'smoke', name: 'bash', arguments: {} });
        const directory = env.PATH.split(delimiter)[0];
        const launcher = join(directory, process.platform === 'win32' ? 'office-check.ps1' : 'office-check');
        const source = await readFile(launcher, 'utf8');
        assert(source.includes('check_office.py'));
        assert(!source.includes('check.js'));
        assert(!source.includes('tsx'));
        const args = [join(root, 'arguments.json'), 'space and 中文', "apostrophe'value"];
        if (process.platform === 'win32') {
          const { LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local');
          const { PwshLocalExecutor } = await import('@deepseek-ai/dsh-pwsh-local');
          await ctx.plugin(LocalSubprocessRuntime);
          await ctx.plugin(PwshLocalExecutor, { pwshPath: 'powershell.exe' });
          const command = 'office-check ' + args.map(value => "'" + value.replaceAll("'", "''") + "'").join(' ') + '; exit $LASTEXITCODE';
          const result = await (await ctx.shell.execute(ctx.shell.resolve({ command,
            env: { PSExecutionPolicyPreference: 'Restricted' }, dshEnv: env }))).result();
          assert.equal(result.exitCode, 7, result.stderr.text);
        } else {
          const result = await execa(launcher, args, { env, reject: false });
          assert.equal(result.exitCode, 7, result.stderr);
        }
        assert.deepEqual(JSON.parse(await readFile(args[0], 'utf8')), args.slice(1));
        process.stdout.write('built checker passed');
      } finally { await ctx.fiber.dispose(); }
    `
    const result = await execa(process.execPath, ['--input-type=module', '-e', script, root], {
      cwd: packageRoot,
      env: {
        DSH_HOME: join(root, 'home'), DSH_PRIMARY_RUNTIME: runtime, DSH_BUNDLED_PRIMARY_RUNTIME: '',
        NODE_OPTIONS: '', TSX_TSCONFIG_PATH: '',
      },
      timeout: 30_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe('built checker passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
