#!/usr/bin/env python3
"""Run the Feishu receipt and payload actions with synthetic, network-free input.

Only the generated regression shortcut may be imported. The full production
shortcut is never installed or executed by this tool.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import plistlib
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SHORTCUT_NAME = "飞书中转原生回归检查"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("feishu_builder", ROOT / "scripts/build-feishu-shortcut.py")
runtime = load("shared_native_runtime", ROOT / "tests/native_shortcut_smoke.py")


def build_fixture() -> dict:
    return runtime.derive_fixture(builder, SHORTCUT_NAME, {
        "飞书Webhook地址": " \nhttps://example.larkoffice.com/base/workflow/webhook/event/fixture-only \n",
        "Webhook令牌": " \nfixture-only-token \n",
    }, variables={
        "交易金额": "1000.08", "账户余额": "-42.10",
        "规范后的月日时间": "11月02日08:30", "交易描述": "合成金额检查",
        "记账主体": "合成商户", "资金方向": "outflow", "记账类型": "purchase",
        "交易指纹": "fixture-event-only", "入表交易类型": "消费", "资金方向名称": "支出",
        "完整交易时间": "2026-11-02T08:30:00+08:00",
    }, capture_payload=True)


CASES = (
    ("accepted", {"code": 0}, "accepted"),
    ("accepted_text", {"code": " \n0\n "}, "accepted"),
    ("rejected", {"code": 999}, "unconfirmed"),
    ("negative", {"code": -1}, "unconfirmed"),
    ("missing_code", {"message": "no code"}, "unconfirmed"),
    ("empty_code", {"code": " \n\t "}, "unconfirmed"),
    ("invalid_code", {"code": "accepted"}, "unconfirmed"),
)


def run(timeout: float, shortcut: str = SHORTCUT_NAME) -> None:
    if sys.platform != "darwin" or not shutil.which("shortcuts"):
        raise RuntimeError("需要 macOS 和官方 shortcuts CLI；未执行原生回归。")
    identities = set()
    with tempfile.TemporaryDirectory(prefix="feishu-native-smoke-") as temporary:
        for name, response, status in CASES:
            actual = runtime.execute_case(shortcut, name, response, Path(temporary), timeout)
            if actual.get("status") != status:
                raise RuntimeError(f"原生用例 {name} 受理状态不符：{actual.get('status')}")
            expected_message = builder.ACCEPTED_MESSAGE if status == "accepted" else builder.UNCONFIRMED_MESSAGE
            if actual.get("message") != expected_message or "transaction_id" in actual:
                raise RuntimeError(f"原生用例 {name} 错把受理当作入账或返回了错误说明")
            identity = uuid.UUID(actual.get("request_id", ""))
            if identity.version != 4 or identity.variant != uuid.RFC_4122 or identity in identities:
                raise RuntimeError(f"原生用例 {name} 未产生独立 UUIDv4")
            identities.add(identity)
            payload = json.loads(actual["_payload_json"])
            if (payload.get("request_id") != str(identity)
                    or payload.get("amount_text") != "1000.08" or payload.get("balance_text") != "-42.10"
                    or type(payload.get("amount")) not in (float, int) or payload.get("amount") != 1000.08
                    or type(payload.get("balance")) not in (float, int) or payload.get("balance") != -42.10):
                raise RuntimeError(f"原生用例 {name} 的合成金额或请求身份不符")
            if actual.get("shortcut_version") != builder.VERSION or actual.get("parser_version") != "1.1.5":
                raise RuntimeError(f"原生用例 {name} 版本不符，请更新回归工作流")
            print(f"通过：{name}")
    print(f"{len(CASES)} 项飞书原生回归通过（配置、UUID、金额字段、受理码）；没有 HTTP 或真实账单。")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--output", type=Path, required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--shortcut", default=SHORTCUT_NAME)
    run_parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    try:
        if args.command == "build":
            data = plistlib.dumps(build_fixture(), sort_keys=True)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("xb") as output:
                output.write(data)
            print(f"已生成无网络回归工作流：{args.output.resolve()}")
        else:
            if not 0 < args.timeout <= 120:
                raise ValueError("每个用例超时必须在 0 至 120 秒之间")
            run(args.timeout, args.shortcut)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"飞书原生回归失败：{error}\n")


if __name__ == "__main__":
    main()
