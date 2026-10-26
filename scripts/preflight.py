from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import os
import py_compile
import re
import shutil
import subprocess
import tarfile
import time
from pathlib import Path, PurePosixPath

import paramiko


ALLOWED_DIRS = (".openai", "app", "build", "db", "deploy", "drizzle", "lib", "public", "worker")
ALLOWED_FILES = (
    ".dockerignore",
    "docker-compose.server.yml",
    "Dockerfile.server",
    "drizzle.config.ts",
    "eslint.config.mjs",
    "next.config.ts",
    "package-lock.json",
    "package.json",
    "pnpm-workspace.yaml",
    "postcss.config.mjs",
    "tsconfig.json",
    "vite.config.ts",
    "wrangler.server.jsonc",
)
FORBIDDEN_PARTS = {
    ".git",
    ".wrangler",
    ".vinext",
    "node_modules",
    "tests",
    "examples",
    "outputs",
    "work",
    "server-backups",
    "release-artifacts",
}
REMOTE_ROOT = "/opt/nexus-quant-contract-trader"
EXPECTED_PROJECT = "nexus-quant-contract-trader"
EXPECTED_PORT = 61527
EXPECTED_APP_PORT = 61527


def run(command: list[str], cwd: Path, log: Path, timeout: int = 900) -> None:
    completed = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
    )
    log.write_text(completed.stdout + "\n" + completed.stderr, encoding="utf-8")
    if completed.returncode:
        raise RuntimeError(f"命令失败：{' '.join(command)}；日志：{log}")


def server_credentials(workspace: Path) -> tuple[str, int, str, str]:
    document = (workspace.parent / "服务器.txt").read_text(encoding="utf-8-sig")
    host = re.search(r"(?im)^\s*(?:服务器\s*)?ip\s*[:：]\s*(\S+)\s*$", document)
    port = re.search(r"(?im)^\s*SSH端口\s*[:：]\s*(\d+)\s*$", document)
    password = re.search(r"(?im)^\s*root密码\s*[:：]\s*(\S+)\s*$", document)
    if not host or not password:
        raise RuntimeError("服务器连接信息不完整")
    return host.group(1), int(port.group(1)) if port else 22, password.group(1), document


def connect(workspace: Path) -> paramiko.SSHClient:
    host, port, password, _ = server_credentials(workspace)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        host,
        port=port,
        username="root",
        password=password,
        timeout=45,
        banner_timeout=45,
        auth_timeout=45,
    )
    return client


def remote_run(client: paramiko.SSHClient, command: str, timeout: int = 300) -> str:
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f"远端只读检查失败（{status}）：{error[-2000:]}")
    return output.strip()


def copy_release_files(workspace: Path, stage: Path) -> None:
    stage.mkdir(parents=True)
    for name in ALLOWED_DIRS:
        source = workspace / name
        if source.is_dir():
            shutil.copytree(source, stage / name)
    for name in ALLOWED_FILES:
        source = workspace / name
        if source.is_file():
            shutil.copy2(source, stage / name)


def validate_package(stage: Path, server_document: str) -> None:
    files = [path for path in stage.rglob("*") if path.is_file()]
    if not files:
        raise RuntimeError("发布包为空")
    secret_values = set(re.findall(r"(?im)^\s*(?:root密码|API\s*Secret)\s*[:：]\s*(\S+)\s*$", server_document))
    forbidden_patterns = [
        re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----"),
        re.compile(r"(?im)^\s*root密码\s*[:：]"),
    ]
    for path in files:
        relative = path.relative_to(stage)
        lower_parts = {part.lower() for part in relative.parts}
        if lower_parts & FORBIDDEN_PARTS:
            raise RuntimeError(f"发布包包含禁止目录：{relative}")
        if relative.name.lower().startswith(".env") or "服务器" in relative.name:
            raise RuntimeError(f"发布包包含环境或服务器文件：{relative}")
        if path.stat().st_size > 20 * 1024 * 1024:
            raise RuntimeError(f"发布包出现异常大文件：{relative}")
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if any(pattern.search(text) for pattern in forbidden_patterns):
            raise RuntimeError(f"发布包敏感内容扫描失败：{relative}")
        if any(secret and secret in text for secret in secret_values):
            raise RuntimeError(f"发布包包含服务器敏感值：{relative}")
    if (stage.joinpath("dist").exists() or stage.joinpath("node_modules").exists()):
        raise RuntimeError("源码发布包不得携带本地构建结果或依赖目录")
    dockerfile = (stage / "Dockerfile.server").read_text(encoding="utf-8")
    required_docker_steps = (
        "FROM node:22-bookworm-slim AS deps",
        "FROM deps AS build",
        "RUN npm ci",
        "RUN npm run build",
        "FROM node:22-bookworm-slim AS runtime",
        "COPY --from=deps /app/node_modules ./node_modules",
        "COPY --from=build /app/dist ./dist",
        "LABEL com.nexusquant.project=nexus-quant-contract-trader",
        "com.nexusquant.layout=thin-runtime-v1",
        "LABEL com.nexusquant.release=${NQ_RELEASE_ID}",
    )
    if any(step not in dockerfile for step in required_docker_steps):
        raise RuntimeError("生产镜像不是依赖共享、产物薄层的全新多阶段镜像")
    if "FROM nexus-quant-contract-trader" in dockerfile:
        raise RuntimeError("生产镜像禁止继承上一业务版本")
    if "COPY --from=build /app /app" in dockerfile:
        raise RuntimeError("生产镜像不得把完整构建目录复制成每版重复的大层")
    dist_copy = dockerfile.find("COPY --from=build /app/dist ./dist")
    release_arg = dockerfile.find("ARG NQ_RELEASE_ID=local")
    if dist_copy < 0 or release_arg < dist_copy:
        raise RuntimeError("版本号必须在稳定依赖和编译产物复制后注入，避免击穿镜像缓存")


def deterministic_archive(stage: Path, archive: Path) -> str:
    with archive.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as output:
                for path in sorted(stage.rglob("*"), key=lambda item: item.as_posix()):
                    relative = PurePosixPath(path.relative_to(stage).as_posix())
                    info = output.gettarinfo(str(path), arcname=str(relative))
                    # GNU tar warns about epoch-zero timestamps. 1980-01-01 is
                    # deterministic while remaining acceptable to all target tools.
                    info.mtime = 315532800
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    if path.is_file():
                        with path.open("rb") as source:
                            output.addfile(info, source)
                    else:
                        output.addfile(info)
    return hashlib.sha256(archive.read_bytes()).hexdigest()


def load_remote_module(workspace: Path):
    path = workspace / ".deploy" / "remote_release.py"
    py_compile.compile(str(path), doraise=True)
    source = path.read_text(encoding="utf-8")
    required = [
        'REMOTE_ROOT = "/opt/nexus-quant-contract-trader"',
        'COMPOSE_PROJECT = "nexus-quant-contract-trader"',
        "PUBLIC_PORT = 61527",
        "APP_PORT = 61527",
        "validate_receipt",
        "archive_sha256",
        "OTHER_CONTAINERS=unchanged",
        "database_counts",
        "validate_database_counts",
        "docker exec -i",
        "发布期间配置表数量变化",
        "发布期间账本记录减少",
        "INCOMING=empty",
        "FRONTEND_ASSETS=matched",
        "RELEASE_ID=matched",
        "IMAGE_LAYOUT=thin-runtime-v1",
        "HTML_CACHE=no-store",
        "PROJECT_HISTORY=current-plus-rollback",
        "cleanup_project_history",
        "docker ps -aq --filter ancestor=\"$image_id\"",
        "docker image ls -q --no-trunc --filter label=com.nexusquant.project=nexus-quant-contract-trader",
        "docker image inspect -f '{{.Id}}' \"$rollback_tag\"",
        "com.nexusquant.project=nexus-quant-contract-trader",
        'compose_for "$previous" stop liquidation-monitor-runner',
        'compose_for "$previous" stop',
        "DOCKER_BUILDKIT=0 docker build --memory=1280m",
        'available_mb="$(awk',
        'disk_available_mb="$(df',
    ]
    if any(value not in source for value in required):
        raise RuntimeError("受控发布脚本缺少固定边界或验证步骤")
    forbidden = (
        "docker system prune",
        "docker container prune",
        "docker image prune",
        "docker builder prune",
    )
    if any(value in source for value in forbidden):
        raise RuntimeError("受控发布脚本包含全局清理命令")
    ordered = (
        'compose_for "$previous" stop liquidation-monitor-runner',
        '\ncompose_for "$previous" stop\n',
        '[ "$available_mb" -ge 1800 ]',
        '[ "$disk_available_mb" -ge 2500 ]',
        'DOCKER_BUILDKIT=0 docker build --memory=1280m --memory-swap=1280m',
    )
    positions = [source.find(value) for value in ordered]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        raise RuntimeError("受控发布脚本没有按安全顺序暂停本项目并限制构建资源")
    spec = importlib.util.spec_from_file_location("nq_remote_release", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载受控发布脚本")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def remote_inventory(
    client: paramiko.SSHClient,
    *,
    allow_unhealthy_runner_repair: bool = False,
) -> dict[str, object]:
    command = r'''set -e
root=/opt/nexus-quant-contract-trader
printf 'CURRENT=%s\n' "$(basename "$(readlink -f "$root/current")")"
for name in nexus-quant-contract-trader nexus-quant-contract-trader-binance-proxy nexus-quant-contract-trader-live-risk nexus-quant-contract-trader-account-audit nexus-quant-contract-trader-position-intelligence nexus-quant-contract-trader-contract-data nexus-quant-contract-trader-liquidation-monitor nexus-quant-contract-trader-simple-rebound nexus-quant-contract-trader-manual-grid; do
  health_json="$(docker inspect -f '{{json .State.Health}}' "$name")"
  if [ "$health_json" = null ]; then health=none; else health="$(docker inspect -f '{{.State.Health.Status}}' "$name")"; fi
  printf 'CONTAINER=%s|%s|%s|%s\n' "$name" "$(docker inspect -f '{{.Id}}' "$name")" "$(docker inspect -f '{{.State.Status}}' "$name")" "$health"
done
printf 'APP_HTTP=%s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:61527/)"
printf 'APP_AUTH=%s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:61527/api/auth/status)"
printf 'INCOMING=%s\n' "$(find "$root/incoming" -mindepth 1 -maxdepth 1 -type f | wc -l)"
printf 'DATA_FILES=%s\n' "$(find "$root/data" -type f | wc -l)"
printf 'MEM_AVAILABLE_MB=%s\n' "$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
printf 'DISK_AVAILABLE_MB=%s\n' "$(df -Pm "$root" | awk 'NR==2 {print $4}')"
printf 'LOAD1=%s\n' "$(awk '{print $1}' /proc/loadavg)"
docker ps --format 'OTHER={{.Names}}|{{.ID}}' | grep -v '^OTHER=nexus-quant-contract-trader' | sort || true
'''
    def collect() -> tuple[dict[str, object], dict[str, tuple[str, str]]]:
        lines = remote_run(client, command).splitlines()
        result: dict[str, object] = {"containers": [], "other_containers": []}
        for line in lines:
            key, _, value = line.partition("=")
            if key == "CONTAINER":
                result["containers"].append(value)
            elif key == "OTHER":
                result["other_containers"].append(value)
            else:
                result[key.lower()] = int(value) if value.isdigit() else value
        parsed = {entry.split("|", 1)[0]: tuple(entry.split("|")[2:4]) for entry in result["containers"]}
        return result, parsed

    result, parsed = collect()
    if result.get("app_http") != 200 or result.get("app_auth") != 401:
        raise RuntimeError("生产应用内部 HTTP 或登录状态异常")
    if result.get("incoming") != 0:
        raise RuntimeError("生产上传目录不是空目录")
    if int(result.get("mem_available_mb", 0)) < 1200:
        raise RuntimeError("服务器可用内存不足，禁止开始发布")
    if int(result.get("disk_available_mb", 0)) < 2500:
        raise RuntimeError("服务器磁盘余量不足，禁止开始发布")
    if float(result.get("load1", 999)) > 8:
        raise RuntimeError("服务器当前负载过高，禁止开始发布")
    expected = {
        "nexus-quant-contract-trader": ("running", "healthy"),
        "nexus-quant-contract-trader-binance-proxy": ("running", "healthy"),
    }
    runner_names = (
        "nexus-quant-contract-trader-live-risk",
        "nexus-quant-contract-trader-account-audit",
        "nexus-quant-contract-trader-position-intelligence",
        "nexus-quant-contract-trader-contract-data",
        "nexus-quant-contract-trader-liquidation-monitor",
        "nexus-quant-contract-trader-simple-rebound",
        "nexus-quant-contract-trader-manual-grid",
    )
    degraded_runner_names = {
        "nexus-quant-contract-trader-account-audit",
        "nexus-quant-contract-trader-contract-data",
    }
    allowed_runner_states = {
        name: (
            ({("running", "none"), ("running", "healthy"), ("running", "unhealthy"), ("running", "starting")}
             if name in degraded_runner_names else {("running", "none"), ("running", "healthy"), ("running", "unhealthy")})
            if allow_unhealthy_runner_repair or name in degraded_runner_names
            else {("running", "none"), ("running", "healthy")}
        )
        for name in runner_names
    }
    runners_valid = all(
        parsed.get(name) in allowed_runner_states[name]
        for name in runner_names
    )
    if (
        any(parsed.get(name) != state for name, state in expected.items())
        or not runners_valid
        or set(parsed) != {*expected, *runner_names}
    ):
        # Docker may briefly return a partial inspect set while compose is
        # recreating a dependent runner. Re-read once before failing the gate.
        time.sleep(5)
        result, parsed = collect()
        runners_valid = all(parsed.get(name) in allowed_runner_states[name] for name in runner_names)
        if (
            any(parsed.get(name) != state for name, state in expected.items())
            or not runners_valid
            or set(parsed) != {*expected, *runner_names}
        ):
            raise RuntimeError(f"生产容器状态异常：{parsed}")
    return result


def download_current_backup(client: paramiko.SSHClient, target: Path) -> str:
    command = r'''set -Eeuo pipefail
root=/opt/nexus-quant-contract-trader
snapshot="$(mktemp -d "$root/backups/.preflight-snapshot.XXXXXX")"
stopped=0
cleanup_snapshot() {
  resolved="$(readlink -f "$snapshot")"
  case "$resolved" in
    "$root"/backups/.preflight-snapshot.*) rm -rf -- "$resolved" ;;
    *) echo "拒绝清理范围外备份快照" >&2; return 92 ;;
  esac
  if [ "$stopped" = 1 ]; then
    docker start nexus-quant-contract-trader >/dev/null
  fi
}
trap cleanup_snapshot EXIT INT TERM
mkdir -p "$snapshot/data"
# The production D1 file can grow to hundreds of MB.  A live node:sqlite
# backup can wait indefinitely behind the worker's write transaction.  Stop
# the single app container briefly and copy the bind-mounted database files;
# this gives a consistent snapshot and keeps the backup gate deterministic.
if [ "$(docker inspect -f '{{.State.Running}}' nexus-quant-contract-trader)" = true ]; then
  docker stop -t 30 nexus-quant-contract-trader >/dev/null
  stopped=1
fi
(
  cd "$root/data"
  find . -type f \
    ! -name '*.sqlite-wal' \
    ! -name '*.sqlite-shm' \
    -print0 | tar --null -T - -cf -
) | tar -xf - -C "$snapshot/data"

[ "$(find "$snapshot/data" -type f -name '*.sqlite' | wc -l)" -ge 1 ]
GZIP=-1 tar -chzf - -C "$root" current -C "$snapshot" data
'''
    _, stdout, stderr = client.exec_command(command, timeout=3600)
    # The SSH command timeout applies to channel reads as an inactivity
    # timeout. A consistent database snapshot can legitimately produce no
    # stdout for longer than that while SQLite backup is running. Keep the
    # overall command timeout at the SSH layer, but let the channel drain
    # until the remote command exits instead of failing on a quiet interval.
    stdout.channel.settimeout(None)
    stderr.channel.settimeout(None)
    payload = stdout.read()
    error = stderr.read().decode("utf-8", errors="replace")
    status = stdout.channel.recv_exit_status()
    if status or not payload:
        raise RuntimeError(f"当前版本备份失败（{status}）：{error[-1000:]}")
    target.write_bytes(payload)
    with tarfile.open(target, "r:gz") as archive:
        names = archive.getnames()
        if not any(name.startswith("current/") for name in names):
            raise RuntimeError("当前版本备份缺少生产源码")
        if not any(name.startswith("data/") and name.endswith(".sqlite") for name in names):
            raise RuntimeError("当前版本备份缺少一致性数据库快照")
        if any(name.endswith(".sqlite-wal") or name.endswith(".sqlite-shm") for name in names):
            raise RuntimeError("当前版本备份错误包含易变 SQLite WAL/SHM")
    return hashlib.sha256(payload).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument(
        "--allow-unhealthy-runner-repair",
        action="store_true",
        help=(
            "仅用于修复发布：允许发布前本项目实时风控或爆仓监听已运行但健康检查失败；"
            "主应用、代理和发布后候选版本的全部健康门禁仍保持严格"
        ),
    )
    parser.add_argument(
        "--allow-unhealthy-live-risk-repair",
        dest="allow_unhealthy_runner_repair",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    release_id = args.release_id
    if not re.fullmatch(r"\d{8}-\d{6}", release_id):
        raise RuntimeError("发布编号格式必须为 yyyyMMdd-HHmmss")
    if not (workspace / "package.json").is_file():
        raise RuntimeError("工作区无效")
    artifact = workspace.parent / "release-artifacts" / release_id
    if artifact.exists():
        raise RuntimeError("发布编号已存在，请使用新的发布编号")
    artifact.mkdir(parents=True)
    stage = artifact / "stage"
    clean = artifact / "clean-build"
    archive = artifact / f"nexus-quant-{release_id}.tar.gz"
    _, _, _, server_document = server_credentials(workspace)

    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise RuntimeError("未找到 npm")
    run([npm, "run", "lint"], workspace, artifact / "lint.log", timeout=600)
    run([npm, "test"], workspace, artifact / "test.log", timeout=1200)
    copy_release_files(workspace, stage)
    validate_package(stage, server_document)
    archive_sha = deterministic_archive(stage, archive)

    with tarfile.open(archive, "r:gz") as source:
        source.extractall(clean, filter="data")
    run([npm, "ci"], clean, artifact / "clean-install.log", timeout=1200)
    run([npm, "run", "build"], clean, artifact / "clean-build.log", timeout=1200)
    clean_page_assets = sorted(path.name for path in clean.glob("dist/client/assets/page-*.js"))
    if not clean_page_assets:
        raise RuntimeError("第二次干净构建没有生成前端页面资源")
    audit = subprocess.run([npm, "audit", "--omit=dev", "--json"], cwd=clean, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    (artifact / "audit.json").write_text(audit.stdout or "{}", encoding="utf-8")
    audit_json = json.loads(audit.stdout or "{}")
    vulnerabilities = audit_json.get("metadata", {}).get("vulnerabilities", {})
    if int(vulnerabilities.get("critical", 0)) or int(vulnerabilities.get("high", 0)):
        raise RuntimeError("生产依赖存在高危或严重漏洞")

    remote_module = load_remote_module(workspace)
    encoded = __import__("base64").b64encode(remote_module.REMOTE_DEPLOY.encode("utf-8")).decode("ascii")
    backup = artifact / "current-backup.tar.gz"
    with connect(workspace) as client:
        remote_run(client, f"printf '%s' {shlex_quote(encoded)} | base64 -d | bash -n")
        remote_run(
            client,
            "docker image inspect -f '{{index .Config.Labels \"com.nexusquant.release\"}}' nexus-quant-contract-trader:latest >/dev/null",
        )
        remote_run(
            client,
            "DOCKER_BUILDKIT=0 docker build --help | grep -q -- '--memory'",
        )
        inventory = remote_inventory(
            client,
            allow_unhealthy_runner_repair=args.allow_unhealthy_runner_repair,
        )
        backup_sha = download_current_backup(client, backup)

    receipt = {
        "status": "passed",
        "release_id": release_id,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "workspace": str(workspace),
        "archive": str(archive),
        "archive_sha256": archive_sha,
        "backup": str(backup),
        "backup_sha256": backup_sha,
        "checks": {
            "lint": "passed",
            "tests_and_first_build": "passed",
            "package_isolation": "passed",
            "sensitive_scan": "passed",
            "clean_install": "passed",
            "second_clean_build": "passed",
            "source_only_archive": "passed",
            "clean_frontend_assets": clean_page_assets,
            "full_image_build_required": "passed",
            "thin_runtime_image": "passed",
            "remote_release_compile_and_control_flow": "passed",
            "remote_bash_syntax": "passed",
            "remote_docker_template_syntax": "passed",
            "remote_legacy_build_memory_limit_supported": "passed",
            "production_read_only_inventory": inventory,
            "preexisting_unhealthy_runner_repair": (
                "explicitly_allowed"
                if args.allow_unhealthy_runner_repair
                else "not_requested"
            ),
            "production_audit": vulnerabilities,
        },
    }
    receipt_path = workspace / ".deploy" / f"preflight-{release_id}.json"
    receipt_path.parent.mkdir(exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    (artifact / "preflight-receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PREFLIGHT_PASSED receipt={receipt_path} archive={archive} sha256={archive_sha}")


def shlex_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    main()
