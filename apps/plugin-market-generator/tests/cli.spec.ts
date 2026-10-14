/** Command-line validation of the generator's options. */
import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'

afterEach(() => { vi.restoreAllMocks() })

it.each([
  ['32769', '--inline-icon-bytes must be a positive integer up to 32768'],
  ['0', '--inline-icon-bytes must be a positive integer up to 32768'],
])('refuses --inline-icon-bytes %s before reading the source list', async (value, message) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const status = await main(['--input', '/nonexistent/list.txt', '--output', '/nonexistent/index.json', '--title', 'T', '--inline-icon-bytes', value])
  expect(status).toBe(2)
  expect(error).toHaveBeenCalledWith(message)
})
