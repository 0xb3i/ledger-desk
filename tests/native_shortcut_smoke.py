#!/usr/bin/env python3
"""Build and run an isolated, network-free Shortcuts runtime regression.

The generated fixture reuses the production configuration, UUID and receipt
actions. Only the bank-mail parser, transport and interactive result displays
are replaced. It never reads credentials, installs shortcuts or sends HTTP.
Install the signed fixture manually before using the ``run`` command.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHORTCUT_NAME = "个人看板原生回归检查"
SPEC = importlib.util.spec_from_file_location("build_shortcut", ROOT / "scripts/build-shortcut.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def params(action: dict) -> dict:
    return action["WFWorkflowActionParameters"]


def validate_fixture(workflow: dict) -> None:
    actions = workflow["WFWorkflowActions"]
    allowed = {
        "comment", "gettext", "text.replace", "setvariable", "text.match",
        "conditional", "dictionary", "output", "list", "repeat.count",
        "getitemfromlist", "detect.dictionary", "getvalueforkey", "count", "number",
    }
    identifiers = [params(action)["UUID"] for action in actions]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("原生回归工作流包含重复动作 UUID")
    ids = set(identifiers)
    groups = []
    for action in actions:
        name = action["WFWorkflowActionIdentifier"]
        if name not in {f"is.workflow.actions.{item}" for item in allowed}:
            raise ValueError(f"回归工作流包含非许可动作，拒绝生成：{name}")
        value = params(action)
        if "WFControlFlowMode" in value:
            mode, group = value["WFControlFlowMode"], value["GroupingIdentifier"]
            if mode == 0:
                groups.append(group)
            elif not groups or groups[-1] != group:
                raise ValueError("回归工作流控制流分组不匹配")
            elif mode == 2:
                groups.pop()
    if groups:
        raise ValueError("回归工作流控制流未闭合")

    def references(value):
        if isinstance(value, dict):
            if "OutputUUID" in value and value["OutputUUID"] not in ids:
                raise ValueError("回归工作流移除解析器后留下悬空引用")
            for item in value.values():
                references(item)
        elif isinstance(value, list):
            for item in value:
                references(item)

    references(workflow)
    if workflow.get("WFWorkflowImportQuestions"):
        raise ValueError("回归工作流不能包含需要真实配置的导入问题")


def derive_fixture(module, name: str, configurations: dict[str, str], *, variables: dict[str, str] | None = None,
                   capture_payload: bool = False) -> dict:
    # build_workflow performs the production integrity checks before deriving
    # this deliberately synthetic fixture; the public artifact is never edited.
    workflow = copy.deepcopy(module.build_workflow())
    source = plistlib.loads(module.SOURCE.read_bytes())
    parser_ids = {params(action)["UUID"] for action in source["ParserActions"]}
    actions = [action for action in workflow["WFWorkflowActions"] if params(action)["UUID"] not in parser_ids]
    by_id = {params(action)["UUID"]: action for action in actions}
    for config_name, value in configurations.items():
        params(by_id[module.identifier(f"config/{config_name}")])["WFTextActionText"] = module.text(value)

    transport = by_id[module.identifier("request/send")]
    if capture_payload:
        extra = module.Workflow()
        captured = extra.add("fixture/captured-payload", "dictionary", "合成提交内容", WFItems=copy.deepcopy(params(transport)["WFJSONValues"]))
        actions[actions.index(transport):actions.index(transport)] = extra.actions
        result = params(by_id[module.identifier("result")])["WFItems"]["Value"]["WFDictionaryFieldValueItems"]
        result.extend(module.dictionary({"_payload_json": module.reference(captured)})["Value"]["WFDictionaryFieldValueItems"])
    transport["WFWorkflowActionIdentifier"] = "is.workflow.actions.gettext"
    transport["WFWorkflowActionParameters"] = {
        "UUID": module.identifier("request/send"),
        "CustomOutputName": params(transport).get("CustomOutputName", "合成响应"),
        "WFTextActionText": module.text({"Type": "ExtensionInput"}),
    }
    # Preserve each branch and its returned dictionary, suppressing only modal
    # displays so a failed configuration returns not_configured without hanging.
    for action in actions:
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.showresult":
            action["WFWorkflowActionIdentifier"] = "is.workflow.actions.comment"
            action["WFWorkflowActionParameters"] = {
                "UUID": params(action)["UUID"],
                "WFCommentActionText": "原生回归检查通过标准输出接收结果，不显示弹窗。",
            }
    params(by_id[module.identifier("instructions")])["WFCommentActionText"] = (
        f"{name}\n仅使用合成配置和标准输入中的合成响应。"
        "没有网络请求，不解析银行邮件，不写入任何账本。验证完成后可删除。"
    )
    initial = module.Workflow()
    initial.set("手动调试", "否")
    synthetic_outputs = {}
    for key, value in (variables or {}).items():
        initial.set(key, value)
        synthetic_outputs[key] = initial.actions[-2]
        params(synthetic_outputs[key])["CustomOutputName"] = key
    # Replace only the removed parser's output boundary with the corresponding
    # synthetic text output. Receipt, UUID and number conversion actions stay
    # intact, including their native variable parameter serialization.
    def replace_parser_outputs(value):
        if isinstance(value, dict):
            if value.get("Type") == "ActionOutput" and value.get("OutputUUID") in parser_ids:
                output_name = value.get("OutputName")
                if output_name not in synthetic_outputs:
                    raise ValueError("回归工作流缺少已移除解析器输出的合成输入")
                value.clear()
                value.update(module.reference(synthetic_outputs[output_name]))
            else:
                for child in value.values():
                    replace_parser_outputs(child)
        elif isinstance(value, list):
            for child in value:
                replace_parser_outputs(child)
    replace_parser_outputs(actions)
    workflow["WFWorkflowActions"] = initial.actions + actions
    workflow["WFWorkflowImportQuestions"] = []
    workflow["WFWorkflowName"] = name
    validate_fixture(workflow)
    return workflow


def build_fixture() -> dict:
    return derive_fixture(builder, SHORTCUT_NAME, {
        "服务地址": " \nhttps://example.invalid/// \n",
        "设备令牌": " \n" + "pd_device_" + "a" * 43 + " \n",
    })


def execute_case(shortcut: str, name: str, response: dict, directory: Path, timeout: float) -> dict:
    source, output = directory / f"{name}.json", directory / f"{name}-result.txt"
    source.write_text(json.dumps(response))
    try:
        result = subprocess.run(
            ["shortcuts", "run", shortcut, "--input-path", str(source),
             "--output-path", str(output), "--output-type", "public.plain-text"],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"原生用例 {name} 超时，未通过；请检查已导入的回归工作流。") from error
    if result.returncode != 0:
        raise RuntimeError(f"原生用例 {name} 执行失败：{(result.stderr or result.stdout).strip()[:500]}")
    if not output.is_file():
        raise RuntimeError(f"原生用例 {name} 没有返回结果，未通过。")
    return json.loads(output.read_text())


def build(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Do not overwrite an older fixture silently; it may already be installed.
    with path.open("xb") as output:
        output.write(plistlib.dumps(build_fixture(), sort_keys=True))
    print(f"已生成无网络回归工作流：{path.resolve()}")
    print(f"使用 shortcuts sign 签名后，以「{SHORTCUT_NAME}」导入，再执行本工具 run。")


def run(timeout: float, shortcut: str = SHORTCUT_NAME) -> None:
    if sys.platform != "darwin" or not shutil.which("shortcuts"):
        raise RuntimeError("实际运行验证需要 macOS 和官方 shortcuts CLI；未执行验证。")
    cases = [
        ("created", "created", " \nfixture-created \n", "created", "fixture-created"),
        ("duplicate", "duplicate", "fixture-duplicate", "duplicate", "fixture-duplicate"),
        ("needs_review", "needs_review", "fixture-review", "needs_review", "fixture-review"),
        ("empty_id", "created", " \n\t ", "unconfirmed", ""),
        ("unknown_status", "accepted", "fixture-unknown", "unconfirmed", "fixture-unknown"),
    ]
    identities = set()
    with tempfile.TemporaryDirectory(prefix="dashboard-native-smoke-") as temporary:
        directory = Path(temporary)
        for name, status, transaction_id, expected_status, expected_id in cases:
            actual = execute_case(shortcut, name, {"data": {"status": status, "transactionId": transaction_id}}, directory, timeout)
            if actual.get("status") != expected_status or actual.get("transaction_id") != expected_id:
                raise RuntimeError(f"原生用例 {name} 回执不符：{json.dumps(actual, ensure_ascii=False)}")
            identity = uuid.UUID(actual.get("idempotency_key", ""))
            if identity.version != 4 or identity.variant != uuid.RFC_4122 or identity in identities:
                raise RuntimeError(f"原生用例 {name} 未生成唯一的 UUIDv4 请求身份。")
            identities.add(identity)
            if actual.get("shortcut_version") != builder.VERSION or actual.get("parser_version") != "1.1.5":
                raise RuntimeError(f"原生用例 {name} 版本不符，请重新构建并导入回归工作流。")
            print(f"通过：{name}")
    print(f"5 项苹果快捷指令原生运行回归通过（配置、UUID、回执）；未执行邮件解析或 HTTP。")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build", help="生成供手动签名、导入的无网络 plist")
    build_parser.add_argument("--output", type=Path, required=True)
    run_parser = commands.add_parser("run", help=f"调用已导入的「{SHORTCUT_NAME}」运行合成用例")
    run_parser.add_argument("--timeout", type=float, default=30)
    run_parser.add_argument("--shortcut", default=SHORTCUT_NAME, help="已安装的回归快捷指令名称或标识符")
    args = parser.parse_args()
    try:
        if args.command == "build":
            build(args.output)
        else:
            if not 0 < args.timeout <= 120:
                raise ValueError("每条原生用例的超时必须在 0 至 120 秒之间")
            run(args.timeout, args.shortcut)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"原生回归检查失败：{error}\n")


if __name__ == "__main__":
    main()
