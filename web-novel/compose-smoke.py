"""Verify an isolated Compose deployment using an already built/loaded image."""
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import urllib.error
import urllib.request


def smoke(directory: Path, compose: str, previous_image: str | None = None) -> None:
    case = "pagekin-verify-" + secrets.token_hex(4)
    command = ["docker", "compose"] if compose == "docker compose" else [compose]
    password = secrets.token_urlsafe(20)
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    app_url = f"http://127.0.0.1:{port}"
    env = {
        **os.environ, "APP_PASSWORD": password, "APP_SECURE_COOKIE": "0", "APP_ORIGIN": app_url,
        "PAGEKIN_BIND": "127.0.0.1", "PAGEKIN_PORT": str(port), "LLM_MODEL": "", "LLM_API_KEY": "",
    }
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    temporary = TemporaryDirectory(prefix="pagekin-compose-")
    previous_config = Path(temporary.name) / "previous.yaml"
    if previous_image:
        previous_config.write_text(f"services:\n  pagekin:\n    image: {json.dumps(previous_image)}\n", encoding="utf-8")

    def stack(suffix: str, *args: str, stdin: bytes | None = None, previous: bool = False) -> bytes:
        name = case + suffix
        files = ["-f", "compose.yaml", "-f", str(previous_config)] if previous else []
        return subprocess.run(
            [*command, *files, "--project-name", name, *args], cwd=directory,
            env={**env, "PAGEKIN_VOLUME": name + "-data"},
            input=stdin, stdout=subprocess.PIPE, check=True, timeout=90,
        ).stdout

    def request(path: str, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(app_url + path, data, {"Content-Type": "application/json"})
        with client.open(req, timeout=4) as response:
            return json.load(response)

    def ready():
        until = time.monotonic() + 30
        while time.monotonic() < until:
            try:
                state = request("/healthz")
                if state["ok"]:
                    return state["version"]
            except (OSError, urllib.error.HTTPError):
                pass
            time.sleep(0.25)
        raise RuntimeError("Compose service did not become ready")

    def schema(previous: bool = False):
        result = stack("", "exec", "-T", "pagekin", "node", "maintenance.mjs", "verify", "/data/novels.sqlite", previous=previous)
        return json.loads(result)["schema"]

    try:
        stack("", "config", "--quiet")
        stack("", "up", "-d", "--no-build", "--pull", "never", previous=bool(previous_image))
        version = ready()
        request("/api/session", {"password": password})
        project = request("/api/projects", {"title": "发布测试"})
        route = f"/api/projects/{project['id']}/documents"
        chapter = request(route, {"kind": "chapter", "title": "第一章", "number": 1, "body": "容器持久化"})
        path = route + "/" + chapter["id"]
        if previous_image:
            old_version = version
            old_schema = schema(previous=True)
            stack("", "up", "-d", "--force-recreate", "--no-build", "--pull", "never")
            version = ready()
            upgraded_schema = schema()
            assert version != old_version
            assert upgraded_schema > old_schema
            assert request(path)["body"] == "容器持久化"
            assert request(path + "/history")[0]["body"] == "容器持久化"
            print(f"Compose upgrade v{old_version} -> v{version}, schema {old_schema} -> {upgraded_schema}: manuscript and history preserved")
        backup_path = "/data/backups/compose-test.sqlite"
        backup = stack("", "exec", "-T", "pagekin", "node", "maintenance.mjs", "backup", backup_path)
        assert json.loads(backup)["projects"] == 1
        snapshot = stack("", "exec", "-T", "pagekin", "cat", backup_path)
        stack("", "restart", "pagekin")
        assert ready() == version
        assert request(path)["body"] == "容器持久化"
        stack("", "stop", "pagekin")
        result = stack("-restored", "run", "--rm", "--no-deps", "-T", "pagekin",
                       "node", "maintenance.mjs", "restore", stdin=snapshot)
        assert json.loads(result)["projects"] == 1
        stack("-restored", "up", "-d", "--no-build", "--pull", "never")
        assert ready() == version
        try:
            request(path)
        except urllib.error.HTTPError as error:
            assert error.code == 401
        else:
            raise AssertionError("Old session survived database restore")
        request("/api/session", {"password": password})
        assert request(path)["body"] == "容器持久化"
        print(f"Compose v{version}: offline startup, restart, online backup and separate volume restore passed")
    finally:
        for suffix in ("-restored", ""):
            try:
                stack(suffix, "down", "--volumes")
            except subprocess.SubprocessError:
                print(f"Could not clean temporary test project {case + suffix}", file=sys.stderr)
        temporary.cleanup()


if __name__ == "__main__":
    smoke(Path(sys.argv[1]).resolve(), sys.argv[2] if len(sys.argv) > 2 else "docker compose",
          sys.argv[3] if len(sys.argv) > 3 else None)
