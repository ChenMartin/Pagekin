from hashlib import sha256
from pathlib import Path
import re
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def package(output: Path) -> Path:
    root = Path(__file__).resolve().parent
    source = (root / "version.mjs").read_text(encoding="utf-8")
    version = re.search(r"releaseVersion = '([0-9A-Za-z.-]+)'", source).group(1)
    folder = f"pagekin-web-novel-{version}"
    compose = (root / "compose.yaml").read_text(encoding="utf-8")
    if f"image: pagekin-web-novel:{version}\n" not in compose:
        raise ValueError("Compose image and application version differ")
    files = [
        ".dockerignore", ".env.example", "Dockerfile", "compose.yaml", "README.md", "RELEASE.md",
        "server.mjs", "store.mjs", "writing-context.mjs", "review-report.mjs", "desktop-archive.mjs", "desktop-copy.mjs",
        "revision-merge.mjs", "continuation.mjs", "input.mjs", "screenplay-store.mjs", "public/screenplay-ui.mjs",
        "version.mjs", "maintenance.mjs", "semantic.mjs", "public/index.html", "public/app.mjs",
        "public/manuscript.mjs", "public/style.css",
        "package.json", "package-lock.json", "build-editor.mjs", "editor/codemirror.mjs",
    ]
    sources = [(name, root / name) for name in files] + [("LICENSE", root.parent / "LICENSE")]
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"{folder}-fnos.zip"
    staging = target.with_suffix(".zip.partial")
    with ZipFile(staging, "w") as archive:
        for name, path in sorted(sources):
            data = path.read_bytes().replace(b"\r\n", b"\n")
            entry = ZipInfo(f"{folder}/{name}")
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    with ZipFile(staging) as archive:
        if archive.testzip() is not None or len(archive.infolist()) != len(sources):
            raise ValueError("ZIP verification failed")
    staging.replace(target)
    print(f"{sha256(target.read_bytes()).hexdigest()}  {target.name}")
    return target


if __name__ == "__main__":
    package(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd())
