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
from uuid import uuid4


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
        "WEBDAV_BACKUP_URL": "",
        "PAGEKIN_MEDIA": "0",
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

    def request(path: str, payload=None, method: str | None = None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(app_url + path, data, {"Content-Type": "application/json"}, method=method)
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

    def confirmed_episode(project_path, chapter_path, chapter, title):
        final = request(chapter_path + "/status", {"action": "finalize", "baseRev": chapter["rev"]})
        adaptation = request(project_path + "/adaptations", {"mutationId": str(uuid4()), "title": title,
            "format": "short", "aspect": "9:16", "seconds": 90})
        episode = request(project_path + f"/adaptations/{adaptation['id']}/episodes", {"mutationId": str(uuid4()),
            "title": "试片", "season": 1, "number": 1, "sources": [{"id": chapter["id"], "rev": final["rev"]}]})
        episode_path = project_path + f"/episodes/{episode['id']}"
        scene = {"id": str(uuid4()), "title": "启航", "interior": "exterior", "location": "码头", "time": "夜",
            "sourceIds": [chapter["id"]], "elements": [{"id": str(uuid4()), "type": "action", "text": "渔船靠岸。"}]}
        saved = request(episode_path, {"mutationId": str(uuid4()), "baseRev": episode["rev"], "title": episode["title"],
            "scenes": [scene]}, "PUT")
        confirmed = request(episode_path + "/status", {"mutationId": str(uuid4()), "action": "confirm", "baseRev": saved["rev"]})
        assert confirmed["status"] == "confirmed"
        return episode_path, confirmed, scene, saved, final

    try:
        stack("", "config", "--quiet")
        stack("", "up", "-d", "--no-build", "--pull", "never", previous=bool(previous_image))
        version = ready()
        request("/api/session", {"password": password})
        project = request("/api/projects", {"title": "发布测试"})
        project_path = f"/api/projects/{project['id']}"
        route = project_path + "/documents"
        chapter = request(route, {"kind": "chapter", "title": "第一章", "number": 1, "body": "容器持久化"})
        path = route + "/" + chapter["id"]
        legacy_episode = None
        if previous_image:
            old_version = version
            old_schema = schema(previous=True)
            if old_schema >= 11:
                original = request(route, {"kind": "chapter", "title": "旧剧本来源", "number": 2, "body": "升级前的小说定稿"})
                legacy_episode, _, legacy_scene, _, _ = confirmed_episode(project_path, route + "/" + original["id"], original, "升级前剧本")
            stack("", "up", "-d", "--force-recreate", "--no-build", "--pull", "never")
            version = ready()
            upgraded_schema = schema()
            assert version != old_version
            assert upgraded_schema > old_schema
            assert request(path)["body"] == "容器持久化"
            assert request(path + "/history")[0]["body"] == "容器持久化"
            if legacy_episode:
                assert request(legacy_episode)["scenes"] == [legacy_scene]
            print(f"Compose upgrade v{old_version} -> v{version}, schema {old_schema} -> {upgraded_schema}: manuscript and history preserved")
        episode_path = None
        current_schema = schema()
        if current_schema >= 11:
            episode_path, confirmed, scene, saved, final = confirmed_episode(project_path, path, chapter, "发布剧本")
        if current_schema >= 21:
            architecture_path = project_path + "/architecture"
            architecture = request(architecture_path + "/world", {"action": "bind"}, "PUT")
            setting = request(route + "/" + architecture["document_id"])
            fields = "\n\n".join(f"## {key}\n\n{value}" for key, value in zip(
                ["时空与环境", "社会与组织", "规则、限制与代价", "日常与冲突"], ["近未来", "港口自治", "禁火", "夜航"]))
            setting_saved = request(route + "/" + setting["id"], {
                "baseRev": setting["rev"], "mutationId": str(uuid4()), "title": setting["title"], "body": fields}, "PUT")
            assert request(architecture_path + "/world", {"action": "confirm", "baseRev": setting_saved["rev"]}, "PUT")["status"] == "confirmed"
            thread = request(project_path + "/threads", {
                "title": "港口线索", "body": "", "kind": "foreshadow", "status": "open", "planted": 1})
            evidence_path = project_path + f"/threads/{thread['id']}/evidence"
            assert request(evidence_path, {"phase": "planted", "baseRev": thread["rev"],
                "documentId": chapter["id"], "sourceRev": final["rev"], "start": 0, "quote": "容器持久化"}, "PUT")["current"]
            assert not request("/api/webdav-backup")["enabled"]
        if current_schema >= 22:
            board_path = episode_path + "/storyboard"
            shot = {"id": str(uuid4()), "sceneId": scene["id"], "size": "wide", "durationMs": 3500, "visual": "渔船靠岸全景"}
            board = request(board_path, {"action": "save", "baseRev": 0, "scriptRev": confirmed["rev"],
                "shots": [shot], "mutationId": str(uuid4())}, "PUT")
            confirmed_board = request(board_path, {"action": "confirm", "baseRev": board["rev"],
                "scriptRev": confirmed["rev"], "mutationId": str(uuid4())}, "PUT")
            assert confirmed_board["status"] == "confirmed"
        if current_schema >= 23:
            timeline_path = episode_path + "/timeline"
            initial = request(timeline_path)
            assert initial["boardRev"] == confirmed_board["rev"]
            clips = [{**initial["clips"][0], "caption": "渔船靠岸。"}]
            timeline = request(timeline_path, {"action": "save", "baseRev": 0, "boardRev": initial["boardRev"],
                "clips": clips, "narration": None, "mutationId": str(uuid4())}, "PUT")
            assert timeline["rev"] == 1
        backup_path = "/data/backups/compose-test.sqlite"
        backup = stack("", "exec", "-T", "pagekin", "node", "maintenance.mjs", "backup", backup_path)
        assert json.loads(backup)["projects"] == 1
        snapshot = stack("", "exec", "-T", "pagekin", "cat", backup_path)
        stack("", "restart", "pagekin")
        assert ready() == version
        assert request(path)["body"] == "容器持久化"
        if current_schema >= 21:
            assert request(architecture_path)[0]["status"] == "confirmed"
            assert request(evidence_path + "?phase=planted")["evidence"]["quote"] == "容器持久化"
        if episode_path:
            assert request(episode_path)["status"] == "confirmed"
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
        if current_schema >= 21:
            assert request(architecture_path)[0]["status"] == "confirmed"
            assert request(evidence_path + "?phase=planted")["evidence"]["quote"] == "容器持久化"
            print("Confirmed architecture and final-chapter evidence survived backup and restore")
        if current_schema >= 22:
            assert request(board_path) == confirmed_board
            assert request(episode_path + "/storyboard-history?rev=1")["shots"][0]["visual"] == shot["visual"]
            print("Storyboard, source screenplay revision and shot history survived backup and restore")
        if current_schema >= 23:
            assert request(timeline_path) == timeline
            print("Timeline and storyboard binding survived backup and restore")
        if episode_path:
            restored = request(episode_path)
            assert restored["status"] == "confirmed"
            assert restored["scenes"] == [scene]
            assert request(episode_path + f"/source?chapter={chapter['id']}")["body"] == "容器持久化"
            assert request(episode_path + f"/history?rev={saved['rev']}")["scenes"] == [scene]
            print("Confirmed screenplay, pinned source and episode history survived backup and restore")
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
