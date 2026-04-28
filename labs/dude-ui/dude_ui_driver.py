#!/usr/bin/env python3
"""
Local-only Wine UI driver for The Dude.

This first pass is deliberately simple: it launches/focuses the Wine client,
types the login tuple into known relative positions, and captures diagnostics.
DB/export diffs are the source of truth for assertions.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_CLIENT = Path.home() / ".wine/drive_c/Program Files (x86)/dude/dude.exe"

# Relative coordinates from the visible top-left of the Wine Dude login window.
LOGIN_POINTS = {
    "server": (345, 78),
    "port": (345, 104),
    "username": (345, 130),
    "password": (345, 157),
    "connect": (460, 78),
}


def load_pyautogui():
    try:
        import pyautogui  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "pyautogui is not installed. Install local UI deps with:\n"
            "  python3 -m pip install --user pyautogui pillow opencv-python"
        ) from exc
    return pyautogui


def screenshot(pyautogui, directory: Path, name: str, enabled: bool) -> None:
    if not enabled:
        return
    directory.mkdir(parents=True, exist_ok=True)
    try:
        pyautogui.screenshot(str(directory / name))
    except Exception as exc:
        print(f"warning: screenshot failed: {exc}", file=sys.stderr)


def click_relative(pyautogui, origin_x: int, origin_y: int, name: str) -> None:
    x, y = LOGIN_POINTS[name]
    pyautogui.click(origin_x + x, origin_y + y)


def replace_text(pyautogui, text: str) -> None:
    pyautogui.hotkey("ctrl", "a")
    pyautogui.write(text, interval=0.01)


def command_doctor(_args: argparse.Namespace) -> int:
    print(f"wine: {shutil.which('wine') or 'NOT FOUND'}")
    client = Path(os.environ.get("DONNY_DUDE_CLIENT", str(DEFAULT_CLIENT))).expanduser()
    print(f"dude.exe: {client} ({'ok' if client.exists() else 'missing'})")
    print(f"python: {sys.executable}")
    try:
        pyautogui = load_pyautogui()
        shot = pyautogui.screenshot()
        print(f"pyautogui: ok, screenshot={shot.size[0]}x{shot.size[1]}")
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 1
    except Exception as exc:  # macOS permissions commonly fail here.
        print(f"pyautogui: failed ({exc})", file=sys.stderr)
        print("Check macOS Accessibility and Screen Recording permissions.", file=sys.stderr)
        return 1
    return 0


def command_login(args: argparse.Namespace) -> int:
    pyautogui = load_pyautogui()
    client = Path(args.client).expanduser()

    screenshot_dir = Path(args.screenshot_dir)
    proc = None
    if args.launch:
        if not client.exists():
            print(f"dude.exe not found: {client}", file=sys.stderr)
            return 1
        wine = shutil.which("wine")
        if not wine:
            print("wine not found on PATH", file=sys.stderr)
            return 1
        proc = subprocess.Popen([wine, str(client)])
        time.sleep(args.launch_wait)
    screenshot(pyautogui, screenshot_dir, "01-login-before.png", args.screenshots)

    click_relative(pyautogui, args.origin_x, args.origin_y, "server")
    replace_text(pyautogui, args.server)
    click_relative(pyautogui, args.origin_x, args.origin_y, "port")
    replace_text(pyautogui, str(args.port))
    click_relative(pyautogui, args.origin_x, args.origin_y, "username")
    replace_text(pyautogui, args.username)
    click_relative(pyautogui, args.origin_x, args.origin_y, "password")
    replace_text(pyautogui, args.password)
    screenshot(pyautogui, screenshot_dir, "02-login-filled.png", args.screenshots)

    if args.connect:
        click_relative(pyautogui, args.origin_x, args.origin_y, "connect")
        time.sleep(args.connect_wait)
        screenshot(pyautogui, screenshot_dir, "03-after-connect.png", args.screenshots)

    if proc:
        print(f"started dude.exe pid={proc.pid}")
    print(f"screenshots: {screenshot_dir}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local Wine UI driver for The Dude")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="check local UI automation prerequisites")
    doctor.set_defaults(func=command_doctor)

    login = sub.add_parser("login", help="fill the Dude login screen")
    login.add_argument("--client", default=os.environ.get("DONNY_DUDE_CLIENT", str(DEFAULT_CLIENT)))
    login.add_argument("--server", default="localhost")
    login.add_argument("--port", type=int, required=True)
    login.add_argument("--username", default="admin")
    login.add_argument("--password", default="")
    login.add_argument("--origin-x", type=int, default=0)
    login.add_argument("--origin-y", type=int, default=0)
    login.add_argument("--launch-wait", type=float, default=4.0)
    login.add_argument("--connect-wait", type=float, default=8.0)
    login.add_argument("--screenshot-dir", default="labs/dude-ui/artifacts")
    login.add_argument("--screenshots", action=argparse.BooleanOptionalAction, default=True)
    login.add_argument("--connect", action=argparse.BooleanOptionalAction, default=True)
    login.add_argument("--launch", action=argparse.BooleanOptionalAction, default=True)
    login.set_defaults(func=command_login)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
