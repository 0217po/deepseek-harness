"""Opt-in native CUA check against an isolated Electron/Chromium application.

Pass --electron /absolute/path/to/Electron.app/Contents/MacOS/Electron, or use
an existing apps/desktop/node_modules/electron/dist installation. This check
never downloads a runtime. It requires Accessibility and Screen Recording.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from native_test_support import ROOT, NativeHelper, line, stop_group


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--electron', type=Path, help='Existing Electron executable; no download is attempted')
    parser.add_argument('--artifacts', type=Path, help='Save fixture-only PNG and private protocol transcript')
    args = parser.parse_args()
    repo = ROOT.parents[3]
    executable = args.electron or repo / 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    if os.uname().sysname != 'Darwin':
        raise RuntimeError('this opt-in check requires macOS')
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError('Electron runtime unavailable; pass --electron with an existing executable')
    if args.artifacts:
        args.artifacts.mkdir(parents=True, exist_ok=True)
    transcript = []
    with tempfile.TemporaryDirectory(prefix='dsh-cua-electron-') as directory:
        root = Path(directory)
        state_path = root / 'state.json'
        # The fixture receives only launch essentials, not the harness environment.
        environment = {key: value for key, value in os.environ.items() if key in {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'}}
        with (root / 'electron.stderr.log').open('w+') as diagnostics:
            fixture = subprocess.Popen([str(executable.resolve()), str(ROOT / 'tests/electron-fixture.mjs'), directory],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=diagnostics,
                                       text=True, env=environment, start_new_session=True)
            helper = None
            try:
                ready = line(fixture, 30).strip()
                assert ready.startswith('READY '), ready
                runtime = json.loads(ready.removeprefix('READY '))
                assert runtime['pid'] == fixture.pid
                helper = NativeHelper(transcript)
                call = helper.call
                permission = call('getCapabilities', {})['permissions']
                assert permission == {'accessibility': True, 'screenRecording': True}, permission
                app = call('getApp', {'selector': str(fixture.pid)})
                owner = {'appHandle': app['appHandle']}
                deadline = time.monotonic() + 15
                while True:
                    windows = call('listWindows', owner)
                    selected = [window for window in windows if window['title'] == 'DSH CUA Electron fixture' and window['isOnScreen']
                                and window['bounds']['width'] > 0 and window['bounds']['height'] > 0]
                    if len(selected) == 1:
                        break
                    if time.monotonic() >= deadline:
                        raise AssertionError('Electron window did not become available: ' + json.dumps(windows))
                    time.sleep(0.025)
                window_id = selected[0]['windowId']
                params = {**owner, 'windowId': window_id, 'maxElements': 400, 'maxDepth': 25}

                def observe():
                    return call('getState', params)

                def targets(state):
                    buttons = [element for element in state['elements'] if element['role'] == 'AXButton' and
                               'Increment Electron' in (element.get('title') or element.get('description') or '')]
                    fields = [element for element in state['elements'] if element['role'] == 'AXTextField' and element['bounds']]
                    return buttons, fields

                # AX enablement is asynchronous in Chromium; the controls themselves signal readiness.
                deadline = time.monotonic() + 15
                while True:
                    state = observe()
                    buttons, fields = targets(state)
                    if len(buttons) == 1 and len(fields) == 1:
                        break
                    if time.monotonic() >= deadline:
                        raise AssertionError('Chromium accessibility did not expose the fixture controls: ' + state['tree'])
                    time.sleep(0.025)

                def wait_state(predicate, description):
                    deadline = time.monotonic() + 5
                    while True:
                        actual = json.loads(state_path.read_text())
                        if predicate(actual):
                            return actual
                        if time.monotonic() >= deadline:
                            raise AssertionError(description + ': ' + json.dumps(actual))
                        time.sleep(0.025)

                call('click', {**owner, 'snapshotId': state['snapshotId'], 'elementIndex': buttons[0]['index']})
                wait_state(lambda actual: actual['clicks'] == 1 and actual['lastClickTrusted'] is True,
                           'Native AX press did not produce one trusted DOM click')
                state = observe()
                assert 'Clicks: 1' in state['tree'], state['tree']
                _, fields = targets(state)
                field = fields[0]['bounds']
                window = next(window for window in state['windows'] if window['windowId'] == window_id)
                call('click', {**owner, 'windowId': window_id, 'snapshotId': state['snapshotId'],
                               'x': field[0] + field[2] / 2 - window['bounds']['x'],
                               'y': field[1] + field[3] / 2 - window['bounds']['y']})
                call('typeText', {**owner, 'text': 'Electron 中文 🧪'})
                wait_state(lambda actual: actual['text'] == 'Electron 中文 🧪' and actual['lastInputTrusted'] is True,
                           'Chromium did not receive complete trusted Unicode input')
                call('pressKey', {**owner, 'key': 'a', 'modifiers': ['command']})
                call('typeText', {**owner, 'text': '第二次 Electron'})
                wait_state(lambda actual: actual['text'] == '第二次 Electron', 'Chromium Command+A did not replace the field')
                image = call('screenshot', {**owner, 'windowId': window_id})
                png = base64.b64decode(image['data'], validate=True)
                assert png.startswith(b'\x89PNG\r\n\x1a\n')
                assert image['pixelWidth'] == int.from_bytes(png[16:20], 'big')
                assert image['pixelHeight'] == int.from_bytes(png[20:24], 'big')
                if args.artifacts:
                    (args.artifacts / 'electron-input.png').write_bytes(png)
                    (args.artifacts / 'fixture-state.json').write_text(state_path.read_text())
                helper.eof()
                print(f"PASS: Electron {runtime['electron']} native AX readiness, trusted DOM click, Unicode input, Command+A replacement, PNG capture")
            except Exception:
                diagnostics.flush()
                diagnostics.seek(0)
                print(diagnostics.read()[-8192:])
                raise
            finally:
                if args.artifacts:
                    (args.artifacts / 'transcript.json').write_text(json.dumps(transcript, ensure_ascii=False, indent=2) + '\n')
                if helper is not None:
                    helper.stop()
                stop_group(fixture)


if __name__ == '__main__':
    main()
