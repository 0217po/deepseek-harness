/** Copy the shared native substitute into this replay's private execution directory. */
import { chmod, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply as consent } from '../cua-native/consent-fixture.mjs'
export const name = 'cua-ptc-fixture'
export const inject = ['userQuestions']

/** Prepare the owned helper before answering native application consent. */
export async function apply(ctx) {
  const helper = join(process.cwd(), 'native-helper.mjs')
  await copyFile(new URL('../cua-native/workspace/native-helper.mjs', import.meta.url), helper)
  await chmod(helper, 0o700)
  await consent(ctx)
}
