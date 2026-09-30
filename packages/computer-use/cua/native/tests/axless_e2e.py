"""Opt-in AX-present -> AXless -> AX-present window regression; requires an unlocked Mac.

Build the helper first. This runner compiles only its owned AppKit fixture,
changes no system permission settings, and controls no user applications.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

from native_test_support import ROOT, NativeHelper, line, stop_group


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, help="Existing native helper executable for this run")
    args = parser.parse_args()
    if os.uname().sysname != 'Darwin':
        raise RuntimeError('this opt-in check requires macOS')
    helper = NativeHelper([], args.helper)
    fixture = None
    foreground = None
    try:
        capabilities = helper.call('getCapabilities', {})
        if capabilities['sessionLocked'] is not False:
            raise RuntimeError('Unlock the macOS console session before running this interactive check')
        if capabilities['permissions'] != {'accessibility': True, 'screenRecording': True}:
            raise RuntimeError('Accessibility and Screen Recording grants are required')
        with tempfile.TemporaryDirectory(prefix='dsh-cua-axless-') as directory:
            root = Path(directory)
            state_path = root / 'state.json'
            binary = root / 'axless-fixture'
            subprocess.run(['swiftc', str(ROOT / 'tests/AxlessFixture.swift'), '-o', str(binary)], check=True)
            fixture = subprocess.Popen([str(binary), str(state_path)], stdout=subprocess.PIPE,
                                       text=True, start_new_session=True)
            try:
                assert line(fixture).strip() == 'READY'

                def wait_state(predicate, description):
                    deadline = time.monotonic() + 5
                    while True:
                        state = json.loads(state_path.read_text())
                        assert state['pid'] == fixture.pid
                        if predicate(state):
                            return state
                        if time.monotonic() >= deadline:
                            raise AssertionError(description + ': ' + json.dumps(state))
                        time.sleep(0.025)

                actual = wait_state(lambda state: not state['hiddenAX'], 'fixture did not initialize')
                app = helper.call('getApp', {'selector': str(fixture.pid)})
                owner = {'appHandle': app['appHandle']}
                window_id = actual['windowId']
                params = {**owner, 'windowId': window_id, 'maxElements': 100, 'maxDepth': 15}
                helper.call('click', {**owner, 'windowId': window_id, 'x': 1, 'y': 1}, 'STALE_SNAPSHOT')
                first = helper.call('getState', params)
                buttons = [element for element in first['elements'] if element['title'] == 'Increment AXless fixture']
                assert len(buttons) == 1, first
                old_index = {**owner, 'snapshotId': first['snapshotId'], 'elementIndex': buttons[0]['index']}
                os.kill(fixture.pid, signal.SIGUSR1)
                actual = wait_state(lambda state: state['hiddenAX'], 'fixture did not remove its AX roots')
                empty = helper.call('getState', params)
                assert empty['tree'] == '' and empty['elements'] == [] and empty['truncated'] is False, empty
                assert empty['snapshotId'] != first['snapshotId']
                helper.call('click', old_index, 'STALE_SNAPSHOT')
                helper.call('click', {**owner, 'snapshotId': empty['snapshotId'], 'elementIndex': 0}, 'INVALID_ARGUMENT')
                capture = helper.call('screenshot', {**owner, 'windowId': window_id})
                assert base64.b64decode(capture['data'], validate=True).startswith(b'\x89PNG\r\n\x1a\n')
                x, y = actual['buttonPoint']
                helper.call('click', {**owner, 'windowId': window_id, 'snapshotId': empty['snapshotId'], 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 1, 'AXless coordinate click did not reach the native button exactly once')
                os.kill(fixture.pid, signal.SIGUSR2)
                wait_state(lambda state: not state['hiddenAX'], 'fixture did not restore AX')
                recovered = helper.call('getState', params)
                assert 'Increment AXless fixture' in recovered['tree']
                helper.call('click', {**owner, 'windowId': window_id, 'snapshotId': empty['snapshotId'], 'x': x, 'y': y}, 'STALE_SNAPSHOT')

                os.kill(fixture.pid, signal.SIGWINCH)
                actual = wait_state(lambda state: state['resizeCount'] == 1, 'fixture did not resize')
                for snapshot in [{}, {'snapshotId': recovered['snapshotId']}]:
                    target = {**owner, 'windowId': window_id, **snapshot}
                    helper.call('click', {**target, 'x': x, 'y': y}, 'WINDOW_CHANGED')
                    helper.call('scroll', {**target, 'x': x, 'y': y, 'deltaLinesY': -1}, 'WINDOW_CHANGED')
                    helper.call('drag', {**target, 'fromX': x, 'fromY': y, 'toX': x + 1, 'toY': y,
                                         'durationMs': 100, 'steps': 2}, 'WINDOW_CHANGED')
                assert json.loads(state_path.read_text())['count'] == 1
                helper.call('getState', params)
                x, y = actual['buttonPoint']
                helper.call('click', {**owner, 'windowId': window_id, 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 2, 'fresh AX did not admit resized-window input')

                os.kill(fixture.pid, signal.SIGURG)
                wait_state(lambda state: state['moved'], 'fixture did not move')
                helper.call('click', {**owner, 'windowId': window_id, 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 3, 'window movement invalidated local coordinates')

                os.kill(fixture.pid, signal.SIGWINCH)
                actual = wait_state(lambda state: state['resizeCount'] == 2, 'fixture did not resize again')
                helper.call('screenshot', {**owner, 'windowId': window_id})
                x, y = actual['buttonPoint']
                helper.call('click', {**owner, 'windowId': window_id, 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 4, 'fresh screenshot did not admit resized-window input')

                foreground_path = root / 'foreground.json'
                foreground = subprocess.Popen([str(binary), str(foreground_path)], stdout=subprocess.PIPE,
                                              text=True, start_new_session=True)
                assert line(foreground).strip() == 'READY'
                wait_state(lambda state: not state['active'], 'foreground fixture did not take focus')
                for number, key, target in [(signal.SIGALRM, 'hidden', owner),
                                            (signal.SIGHUP, 'minimized', {**owner, 'windowId': window_id})]:
                    os.kill(fixture.pid, number)
                    wait_state(lambda state: state[key], 'fixture did not ' + key)
                    restored = helper.call('show', target)
                    actual = wait_state(lambda state: not state[key], 'show did not restore ' + key)
                    assert restored['windowId'] == window_id, restored
                    assert restored['dispatched'] and not restored['verified'], restored
                    assert restored['foregroundChanged'] is False, restored
                    assert not actual['active'] and json.loads(foreground_path.read_text())['active']
                helper.call('show', {**owner, 'windowId': json.loads(foreground_path.read_text())['windowId']}, 'WINDOW_UNAVAILABLE')
                helper.eof()
                print('PASS: AXless input, resize guards, fresh observation, movement and background unhide/unminimize')
            finally:
                stop_group(fixture)
                fixture = None
    finally:
        if foreground is not None:
            stop_group(foreground)
        if fixture is not None:
            stop_group(fixture)
        helper.stop()


if __name__ == '__main__':
    main()
