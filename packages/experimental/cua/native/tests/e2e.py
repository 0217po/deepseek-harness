"""Opt-in macOS integration against a disposable two-window AppKit application.

Build dsh-cua-native first, then run this file with Python 3. macOS Accessibility
and Screen Recording permission must already be granted to the responsible host.
The fixture records its own received actions; native dispatch success is not the
assertion. --artifacts saves fixture-only screenshots and a private transcript.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from native_test_support import ROOT, NativeHelper, line, stop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, help="Save fixture screenshots and private JSON protocol transcript")
    artifacts = parser.parse_args().artifacts
    if artifacts is not None:
        artifacts.mkdir(parents=True, exist_ok=True)
    transcript = []
    if os.uname().sysname != "Darwin":
        raise RuntimeError("this opt-in check requires macOS")
    with tempfile.TemporaryDirectory(prefix="dsh-cua-fixture-") as directory:
        fixture_binary = Path(directory) / "dsh-cua-fixture"
        state_path = Path(directory) / "state.json"
        subprocess.run(["swiftc", str(ROOT / "tests" / "Fixture.swift"), "-o", str(fixture_binary)], check=True)
        fixture = subprocess.Popen([str(fixture_binary), str(state_path)], stdout=subprocess.PIPE, text=True)
        helper = None
        try:
            assert line(fixture).strip() == "READY"
            helper = NativeHelper(transcript)
            call = helper.call

            def wait_state(predicate, description):
                deadline = time.monotonic() + 5
                while True:
                    state = json.loads(state_path.read_text())
                    if predicate(state):
                        return state
                    if time.monotonic() >= deadline:
                        raise AssertionError(description + ": " + json.dumps(state))
                    time.sleep(0.025)

            capabilities = call("getCapabilities", {})
            assert capabilities["platform"] == "macos", capabilities
            assert capabilities["permissions"] == {"accessibility": True, "screenRecording": True}, capabilities
            apps = call("listApps", {})
            assert any(app["pid"] == fixture.pid for app in apps), apps
            app = call("getApp", {"selector": str(fixture.pid)})
            handle = app["appHandle"]
            assert app["pid"] == fixture.pid and isinstance(handle, str) and handle
            assert call("getApp", {"selector": str(fixture.pid)})["appHandle"] == handle
            owner = {"appHandle": handle}
            deadline = time.monotonic() + 5
            while True:
                windows = call("listWindows", owner)
                primary = next(window for window in windows if window["title"] == "DSH CUA primary fixture")
                secondary = next(window for window in windows if window["title"] == "DSH CUA secondary fixture")
                actual = json.loads(state_path.read_text())
                sizes = [[window["bounds"]["width"], window["bounds"]["height"]] for window in [primary, secondary]]
                if sizes == [actual["primaryWindowSize"], actual["secondaryWindowSize"]]:
                    break
                if time.monotonic() >= deadline:
                    raise AssertionError("WindowServer has not finished presenting the fixture windows")
                time.sleep(0.025)
            primary_params = {**owner, "windowId": primary["windowId"], "maxElements": 300, "maxDepth": 20}
            secondary_params = {**owner, "windowId": secondary["windowId"], "maxElements": 300, "maxDepth": 20}
            first = call("getState", primary_params)
            second = call("getState", secondary_params)
            assert "Increment secondary" not in first["tree"], first
            assert "Increment primary" not in second["tree"], second

            def button_target(state, title):
                matches = [element for element in state["elements"] if element["role"] == "AXButton" and element["title"] == title]
                assert len(matches) == 1, state
                return {**owner, "snapshotId": state["snapshotId"], "elementIndex": matches[0]["index"]}

            target = button_target(first, "Increment primary")
            call("click", target)
            wait_state(lambda state: state["count"] == 1, "primary click was not received exactly once")
            call("click", button_target(second, "Increment secondary"))
            wait_state(lambda state: state["secondaryCount"] == 1, "second window snapshot was invalidated by primary action")
            first = call("getState", primary_params)
            call("click", target, "STALE_SNAPSHOT")
            call("click", button_target(second, "Increment secondary"))
            wait_state(lambda state: state["secondaryCount"] == 2, "refresh invalidated another window snapshot")
            call("click", {**owner, "snapshotId": second["snapshotId"], "windowId": primary["windowId"], "x": 30, "y": 30}, "STALE_SNAPSHOT")

            def capture(window, name):
                result = call("screenshot", {**owner, "windowId": window["windowId"]})
                pixels = base64.b64decode(result["data"], validate=True)
                assert pixels.startswith(b"\x89PNG\r\n\x1a\n")
                assert result["pixelWidth"] == int.from_bytes(pixels[16:20], "big")
                assert result["pixelHeight"] == int.from_bytes(pixels[20:24], "big")
                actual = json.loads(state_path.read_text())
                size_key = "primaryWindowSize" if window["windowId"] == primary["windowId"] else "secondaryWindowSize"
                assert result["coordinateSpace"] == "window-points"
                assert [result["bounds"]["width"], result["bounds"]["height"]] == actual[size_key]
                if artifacts is not None:
                    (artifacts / name).write_bytes(pixels)
                return result

            before = capture(primary, "00-primary.png")
            other = capture(secondary, "01-secondary.png")
            assert before["pixelWidth"] != other["pixelWidth"]
            fields = [element for element in first["elements"] if element["role"] == "AXTextField" and element["bounds"] is not None]
            assert len(fields) == 1, first
            field = fields[0]["bounds"]
            call("click", {**owner, "snapshotId": first["snapshotId"], "windowId": primary["windowId"],
                           "x": field[0] + field[2] / 2 - primary["bounds"]["x"],
                           "y": field[1] + field[3] / 2 - primary["bounds"]["y"]})
            call("typeText", {**owner, "text": "中文 CUA 🧪"})
            wait_state(lambda state: state["text"] == "中文 CUA 🧪", "Unicode input was not received completely")
            call("pressKey", {**owner, "key": "a", "modifiers": ["command"]})
            call("typeText", {**owner, "text": "第二次 CUA"})
            call("pressKey", {**owner, "key": "tab"})
            state = wait_state(lambda state: state["text"] == "第二次 CUA", "Command+A replacement or key dispatch was not received")
            x, y, width, height = state["scrollBounds"]
            initial_scroll = state["scrollY"]
            call("scroll", {**owner, "windowId": primary["windowId"], "x": x + width / 2, "y": y + height / 2, "deltaLinesY": -3})
            state = wait_state(lambda state: state["scrollY"] > initial_scroll, "line scroll did not move the actual document")
            x, y, width, height = state["dragBounds"]
            call("drag", {**owner, "windowId": primary["windowId"], "fromX": x + 20, "fromY": y + height / 2,
                          "toX": x + width - 20, "toY": y + height / 2, "durationMs": 250, "steps": 12})
            wait_state(lambda state: state["dragCount"] >= 1 and abs(state["dragPoint"][0] - (width - 20)) < 3,
                       "drag release did not reach the intended document point")
            capture(primary, "02-input-scroll-drag.png")
            call("scroll", {**owner, "windowId": primary["windowId"], "x": 10, "y": 10, "deltaLinesY": 0}, "INVALID_ARGUMENT")
            call("listWindows", {"appHandle": "invalid"}, "STALE_APP")
            call("click", button_target(second, "Close secondary"))
            deadline = time.monotonic() + 5
            while any(window["windowId"] == secondary["windowId"] for window in call("listWindows", owner)):
                if time.monotonic() >= deadline:
                    raise AssertionError("secondary window did not close")
                time.sleep(0.025)
            call("screenshot", {**owner, "windowId": secondary["windowId"]}, "WINDOW_UNAVAILABLE")
            call("click", button_target(second, "Increment secondary"), "STALE_SNAPSHOT")

            selected_file = Path(directory) / "sheet-target.txt"
            selected_file.write_text("Owned file picker fixture\n")
            call("click", button_target(call("getState", primary_params), "Open fixture file"))

            def wait_observation(predicate, description, params=primary_params):
                deadline = time.monotonic() + 5
                while True:
                    observed = call("getState", params)
                    if predicate(observed):
                        return observed
                    if time.monotonic() >= deadline:
                        raise AssertionError(description + ": " + observed["tree"])
                    time.sleep(0.025)

            sheet = wait_observation(lambda observed: any(e["identifier"] == "open-panel" for e in observed["elements"]),
                                     "File panel did not appear")
            sheet_id = sheet["focusedWindowId"]
            assert sheet_id != primary["windowId"], sheet
            scoped = call("getState", {**primary_params, "windowId": sheet_id})
            assert any(e["role"] == "AXSheet" for e in scoped["elements"]), scoped
            assert "Increment primary" not in scoped["tree"], scoped
            call("pressKey", {**owner, "key": "g", "modifiers": ["command", "shift"]})
            goto = wait_observation(lambda observed: any(e["identifier"] == "PathTextField" for e in observed["elements"]),
                                    "Command+Shift+G did not reach the system panel")
            path_field = next(e for e in goto["elements"] if e["identifier"] == "PathTextField")
            call("click", {**owner, "snapshotId": goto["snapshotId"], "elementIndex": path_field["index"]})
            call("pressKey", {**owner, "key": "a", "modifiers": ["command"]})
            call("typeText", {**owner, "text": str(selected_file)})
            wait_observation(lambda observed: any(e["identifier"] == "PathTextField" and e["value"] == str(selected_file)
                                                 for e in observed["elements"]), "Panel text input did not arrive")
            call("pressKey", {**owner, "key": "Return"})
            ready = wait_observation(lambda observed: not any(e["identifier"] == "PathTextField" for e in observed["elements"])
                                     and any(e["identifier"] == "OKButton" and e["enabled"] for e in observed["elements"]),
                                     "Go to folder did not select the requested file")
            open_button = next(e for e in ready["elements"] if e["identifier"] == "OKButton")
            call("click", {**owner, "snapshotId": ready["snapshotId"], "elementIndex": open_button["index"]})
            wait_state(lambda state: state["selectedFile"] == str(selected_file), "File picker did not return the intended URL")
            call("getState", {**primary_params, "windowId": sheet_id}, "WINDOW_UNAVAILABLE")
            stop(fixture)
            call("listWindows", owner, "APP_UNAVAILABLE")
            call("listWindows", owner, "STALE_APP")
            helper.eof()
            print("PASS: capability preflight, two-window snapshots, scoped invalidation, AX readback, Unicode input, real scrolling/drag release, image dimensions, system file panel, stale app cleanup, EOF")
        finally:
            if artifacts is not None:
                (artifacts / "transcript.json").write_text(json.dumps(transcript, ensure_ascii=False, indent=2) + "\n")
            if helper is not None:
                helper.stop()
            stop(fixture)


if __name__ == "__main__":
    main()
