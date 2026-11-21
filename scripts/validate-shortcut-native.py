#!/usr/bin/env python3
"""Validate the public template against macOS WorkflowKit / ActionKit parameters.

This command does not inspect installed shortcuts, sign, install, execute a
workflow, or make network requests. The workflow is instantiated only in memory
to resolve dynamic condition parameters from output types. Actions without
available native parameter definitions are listed in the report.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def public_workflow(kind: str = "direct") -> dict:
    filename = {"direct": "build-shortcut.py", "feishu": "build-feishu-shortcut.py"}[kind]
    spec = importlib.util.spec_from_file_location("public_shortcut_builder", HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_workflow()


def run_native_validation(workflow: dict, swift: str | None = None) -> subprocess.CompletedProcess:
    if sys.platform != "darwin":
        raise RuntimeError("原生参数回读需要 macOS，不支持当前平台。")
    executable = swift or shutil.which("swift")
    if not executable:
        raise RuntimeError("未找到 Swift 命令行工具，无法调用 macOS WorkflowKit / ActionKit。")
    return subprocess.run(
        [executable, str(HERE / "validate-shortcut-native.swift")],
        input=json.dumps(workflow), text=True, capture_output=True, timeout=60,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="原生回读公开快捷指令参数及动态条件；不签名、不安装、不执行。")
    parser.add_argument("--kind", choices=("direct", "feishu"), default="direct", help="选择直连接口或飞书中转公开模板")
    parser.add_argument("--skip-unsupported", action="store_true", help="CI 可显式跳过非 macOS 或缺少原生工具的环境")
    args = parser.parse_args()
    if sys.platform != "darwin" or not shutil.which("swift"):
        message = "需要 macOS、Swift 命令行工具及 WorkflowKit / ActionKit。"
        print(("SKIP " if args.skip_unsupported else "ERROR ") + message)
        return 0 if args.skip_unsupported else 2
    try:
        result = run_native_validation(public_workflow(args.kind))
    except subprocess.TimeoutExpired:
        print("ERROR 原生参数回读超过 60 秒，已停止；未运行快捷指令。", file=sys.stderr)
        return 2
    if result.returncode == 3 and args.skip_unsupported:
        print("SKIP 当前 macOS 未提供所需 WorkflowKit / ActionKit 原生接口。")
        return 0
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
