#!/usr/bin/env python3
"""Build the credential-free CMB shortcut from the reviewed 1.1.5 parser.

No installed shortcut is read, installed or run. --sign invokes Apple's CLI on
the generated public template only. Import questions and random-list parameter
values were checked against macOS WorkflowKit's native definitions.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import plistlib
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "integrations/shortcuts/src/cmb-parser.plist"
VERSION = "1.2.3"
PARSER_SHA256 = "144646f4f6ca683c1da4223bafd46ed5ddf1484436b84f79ec9c33e1da2bb0e3"
NAMESPACE = uuid.UUID("a2fa1363-877d-45f3-b903-314771070559")


def identifier(name: str) -> str:
    return str(uuid.uuid5(NAMESPACE, name)).upper()


def variable(name: str) -> dict:
    return {"Type": "Variable", "VariableName": name}


def reference(action: dict) -> dict:
    params = action["WFWorkflowActionParameters"]
    return {"Type": "ActionOutput", "OutputUUID": params["UUID"], "OutputName": params.get("CustomOutputName", "结果")}


def attachment(value: dict) -> dict:
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def text(*parts: str | dict) -> dict:
    value, ranges = "", {}
    for part in parts:
        if isinstance(part, str):
            value += part
        else:
            position = len(value.encode("utf-16-le")) // 2
            ranges[f"{{{position}, 1}}"] = part
            value += "\ufffc"
    result = {"string": value}
    if ranges:
        result["attachmentsByRange"] = ranges
    return {"Value": result, "WFSerializationType": "WFTextTokenString"}


def dictionary(values: dict) -> dict:
    items = []
    for key, value in values.items():
        items.append({"WFItemType": 0, "WFKey": text(key), "WFValue": text(value)})
    return {"Value": {"WFDictionaryFieldValueItems": items}, "WFSerializationType": "WFDictionaryFieldValue"}


class Workflow:
    def __init__(self):
        self.actions: list[dict] = []

    def add(self, name: str, action: str, output: str | None = None, **parameters) -> dict:
        parameters["UUID"] = identifier(name)
        if output:
            parameters["CustomOutputName"] = output
        result = {"WFWorkflowActionIdentifier": f"is.workflow.actions.{action}", "WFWorkflowActionParameters": parameters}
        self.actions.append(result)
        return result

    def set(self, name: str, value: str | dict) -> None:
        result = self.add(f"{name}/value/{len(self.actions)}", "gettext", WFTextActionText=text(value))
        self.add(f"{name}/set/{len(self.actions)}", "setvariable", WFVariableName=name, WFInput=attachment(reference(result)))

    def begin(self, name: str, value: dict, condition: int, equals: str | None = None, number: int | None = None) -> str:
        group = identifier(f"group/{name}")
        params = {"WFInput": {"Type": "Variable", "Variable": attachment(value)}, "WFControlFlowMode": 0,
                  "GroupingIdentifier": group, "WFCondition": condition}
        if equals is not None:
            params["WFConditionalActionString"] = equals
        if number is not None:
            params["WFNumberValue"] = number
        self.add(f"{name}/if", "conditional", **params)
        return group

    def end(self, name: str, group: str) -> None:
        self.add(f"{name}/end", "conditional", WFControlFlowMode=2, GroupingIdentifier=group)

    def invalid_configuration(self, name: str, matched: dict, message: str) -> None:
        group = self.begin(name, reference(matched), 101)
        result = self.add(f"{name}/result", "dictionary", "配置检查结果", WFItems=dictionary({"status": "not_configured", "message": message}))
        self.add(f"{name}/message", "showresult", Text=text(message))
        self.add(f"{name}/stop", "output", WFOutput=text(reference(result)))
        self.end(name, group)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)


def validate_structure(workflow: dict) -> None:
    actions = workflow["WFWorkflowActions"]
    uuids = [item["WFWorkflowActionParameters"]["UUID"] for item in actions]
    if len(uuids) != len(set(uuids)):
        raise ValueError("快捷指令动作 UUID 重复")
    all_ids = set(uuids)

    def check_references(value):
        if isinstance(value, dict):
            if "OutputUUID" in value and value["OutputUUID"] not in all_ids:
                raise ValueError("快捷指令包含悬空的动作引用")
            for nested in value.values():
                check_references(nested)
        elif isinstance(value, list):
            for nested in value:
                check_references(nested)

    check_references(workflow)
    groups = []
    for item in actions:
        params = item["WFWorkflowActionParameters"]
        if "WFControlFlowMode" in params:
            mode, group = params["WFControlFlowMode"], params["GroupingIdentifier"]
            if mode == 0:
                groups.append(group)
            elif not groups or groups[-1] != group:
                raise ValueError("快捷指令控制流分组不匹配")
            elif mode == 2:
                groups.pop()
    if groups:
        raise ValueError("快捷指令控制流未闭合")
    network = [item for item in actions if item["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl"]
    if len(network) != 1:
        raise ValueError("模板必须只有一个账本 HTTP 提交动作")


def validate_empty_configuration(workflow: dict) -> None:
    actions = workflow["WFWorkflowActions"]
    questions = workflow.get("WFWorkflowImportQuestions", [])
    if len(questions) != 2:
        raise ValueError("模板必须包含两个导入配置问题")
    for question in questions:
        params = actions[question["ActionIndex"]]["WFWorkflowActionParameters"]
        if question["ParameterKey"] != "WFTextActionText" or params["WFTextActionText"] != text(""):
            raise ValueError("公开模板的导入配置必须为空")


def validate(workflow: dict) -> None:
    validate_structure(workflow)
    for value in strings(workflow):
        if re.search(r"(?:feishu|larksuite|larkoffice)\.(?:cn|com)|/webhook/|Bearer [A-Za-z0-9_-]{8,}|pd_device_[A-Za-z0-9_-]{43}", value, re.I):
            raise ValueError("模板包含服务凭据或旧服务地址，拒绝生成")
    validate_empty_configuration(workflow)


def load_parser(source_path: Path = SOURCE) -> dict:
    source = plistlib.loads(source_path.read_bytes())
    if hashlib.sha256(plistlib.dumps(source["ParserActions"], sort_keys=True)).hexdigest() != PARSER_SHA256:
        raise ValueError("解析器源码已变化；请复核解析规则并更新测试与校验哈希")
    return source


def add_request_identity(out: Workflow) -> None:
    # Native Shortcuts has no bundled UUID action. Random Item is a verified
    # WFItemSpecifier; 32 hex draws plus a variant draw yield RFC 9562 UUIDv4.
    hex_list = out.add("uuid/hex", "list", "十六进制字符", WFItems=list("0123456789abcdef"))
    out.set("请求随机串", "")
    repeat = identifier("uuid/repeat-group")
    out.add("uuid/repeat", "repeat.count", WFControlFlowMode=0, GroupingIdentifier=repeat, WFRepeatCount=32)
    char = out.add("uuid/random-hex", "getitemfromlist", "随机字符", WFInput=attachment(reference(hex_list)), WFItemSpecifier="Random Item")
    appended = out.add("uuid/append", "gettext", "累计随机字符", WFTextActionText=text(variable("请求随机串"), reference(char)))
    out.add("uuid/store", "setvariable", WFVariableName="请求随机串", WFInput=attachment(reference(appended)))
    out.add("uuid/repeat-end", "repeat.count", WFControlFlowMode=2, GroupingIdentifier=repeat)
    variants = out.add("uuid/variants", "list", "UUID变体字符", WFItems=list("89ab"))
    variant = out.add("uuid/variant", "getitemfromlist", "UUID变体", WFInput=attachment(reference(variants)), WFItemSpecifier="Random Item")
    request_id = out.add("uuid/format", "text.replace", "本次请求UUID", WFInput=text(variable("请求随机串")),
                         WFReplaceTextFind=r"^([0-9a-f]{8})([0-9a-f]{4})[0-9a-f]([0-9a-f]{3})[0-9a-f]([0-9a-f]{3})([0-9a-f]{12})$",
                         WFReplaceTextReplace=text("$1-$2-4$3-", reference(variant), "$4-$5"),
                         WFReplaceTextRegularExpression=True, WFReplaceTextCaseSensitive=True)
    out.add("request/id", "setvariable", WFVariableName="本次请求身份", WFInput=attachment(reference(request_id)))


def build_workflow(source_path: Path = SOURCE) -> dict:
    source = load_parser(source_path)
    parser = source["ParserActions"]
    workflow = copy.deepcopy(source["WorkflowMetadata"])
    out = Workflow()
    out.add("instructions", "comment", WFCommentActionText=(
        f"招行记账 {VERSION}\n"
        "导入时填写个人看板的 HTTPS 根地址和专用设备令牌。配置后请勿分享含令牌的个人副本。\n"
        "输入为一封招行交易邮件正文。无输入时可以粘贴正文；解析成功后会真实提交账本。\n"
        "邮件解析沿用 1.1.5，金额与余额保留十进制文本。完整日期沿用运行时当前年份与 +08:00；跨年历史邮件需先核对年份。\n"
        "每次运行只生成一次 UUIDv4 请求身份。仅 created、duplicate、needs_review 且有 transactionId 时确认对应保存结果。\n"
        "此模板没有跨自动化离线队列，也不会自动重试网络异常。网络中断后先查询账本；重新运行会生成新请求身份，疑似重复由看板核对。"
    ))
    questions = []
    for name, prompt in [("服务地址", "填写已发布个人看板的 HTTPS 根地址，不含 /api 路径。"),
                         ("设备令牌", "填写看板设置中生成的专用设备令牌，不要填写网页登录密钥。")]:
        questions.append({"ActionIndex": len(out.actions), "Category": "Parameter", "ParameterKey": "WFTextActionText", "Text": prompt})
        value = out.add(f"config/{name}", "gettext", name, WFTextActionText=text(""))
        trimmed = out.add(f"config/{name}/trim", "text.replace", f"整理后的{name}", WFInput=text(reference(value)),
                          WFReplaceTextFind=r"^\s+|\s+$", WFReplaceTextReplace="", WFReplaceTextRegularExpression=True, WFReplaceTextCaseSensitive=True)
        if name == "服务地址":
            trimmed = out.add("config/origin/slashes", "text.replace", "服务根地址", WFInput=text(reference(trimmed)),
                              WFReplaceTextFind=r"/+$", WFReplaceTextReplace="", WFReplaceTextRegularExpression=True, WFReplaceTextCaseSensitive=True)
        out.add(f"config/{name}/set", "setvariable", WFVariableName=name, WFInput=attachment(reference(trimmed)))
    origin = out.add("config/origin/check", "text.match", "有效服务地址", text=text(variable("服务地址")),
                     WFMatchTextPattern=r"^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$", WFMatchTextCaseSensitive=True)
    out.invalid_configuration("config/origin", origin, "请在快捷指令顶部填写已发布看板的 HTTPS 根地址，再运行记账。")
    token = out.add("config/token/check", "text.match", "有效设备令牌", text=text(variable("设备令牌")),
                    WFMatchTextPattern=r"^pd_device_[A-Za-z0-9_-]{43}$", WFMatchTextCaseSensitive=True)
    out.invalid_configuration("config/token", token, "请在快捷指令顶部填写看板生成的专用设备令牌，再运行记账。")

    # This fragment excludes all old HTTP, numeric-upload and receipt actions.
    out.actions.extend(copy.deepcopy(parser))

    add_request_identity(out)

    headers = dictionary({"Authorization": "", "Idempotency-Key": variable("本次请求身份"), "Content-Type": "application/json"})
    headers["Value"]["WFDictionaryFieldValueItems"][0]["WFValue"] = text("Bearer ", variable("设备令牌"))
    request = out.add("request/send", "downloadurl", "账本响应", WFURL=text(variable("服务地址"), "/api/ingest/cmb"),
                      WFHTTPMethod="POST", WFHTTPBodyType="JSON", ShowHeaders=True,
                      WFHTTPHeaders=headers, WFJSONValues=copy.deepcopy(source["RequestFields"]))
    response = out.add("response/dictionary", "detect.dictionary", "账本响应词典", WFInput=attachment(reference(request)))
    data = out.add("response/data", "getvalueforkey", "账本响应数据", WFInput=attachment(reference(response)), WFGetDictionaryValueType="Value", WFDictionaryKey="data")
    raw_status = out.add("response/status", "getvalueforkey", "账本响应状态", WFInput=attachment(reference(data)), WFGetDictionaryValueType="Value", WFDictionaryKey="status")
    # Dictionary values have a dynamic content type. Convert to text so the
    # native If action retains WFConditionalActionString as its comparison.
    status = out.add("response/status-text", "gettext", "账本响应状态文本", WFTextActionText=text(reference(raw_status)))
    transaction_id = out.add("response/transaction-id", "getvalueforkey", "账目ID", WFInput=attachment(reference(data)), WFGetDictionaryValueType="Value", WFDictionaryKey="transactionId")
    clean_id = out.add("response/id-trim", "text.replace", "非空账目ID", WFInput=text(reference(transaction_id)),
                       WFReplaceTextFind=r"^\s+|\s+$", WFReplaceTextReplace="", WFReplaceTextRegularExpression=True, WFReplaceTextCaseSensitive=True)
    # A native text item can exist while its string is empty. Count characters
    # instead of using "has any value", which only checks for an output item.
    id_length = out.add("response/id-length", "count", "账目ID字符数", Input=attachment(reference(clean_id)), WFCountType="Characters")
    out.set("提交状态", "unconfirmed")
    out.set("提交说明", "未确认账目已保存。请先查询看板，再决定是否重新运行；不要把网络受理当作入账成功。")
    has_id = out.begin("response/has-id", reference(id_length), 2, number=0)
    for accepted, message in [("created", "账目已保存。"), ("duplicate", "同一请求已处理，未重复新增账目。"), ("needs_review", "账目已保存，请在看板核对交易性质或重复情况。")]:
        group = out.begin(f"response/{accepted}", reference(status), 4, accepted)
        out.set("提交状态", accepted)
        out.set("提交说明", message)
        out.end(f"response/{accepted}", group)
    out.end("response/has-id", has_id)
    result = out.add("result", "dictionary", "记账结果", WFItems=dictionary({
        "status": variable("提交状态"), "message": variable("提交说明"), "transaction_id": reference(clean_id),
        "idempotency_key": variable("本次请求身份"), "shortcut_version": VERSION, "parser_version": source["ParserVersion"],
    }))
    manual = out.begin("result/manual", variable("手动调试"), 4, "是")
    out.add("result/show", "showresult", Text=text(variable("提交说明")))
    out.end("result/manual", manual)
    out.add("result/return", "output", WFOutput=text(reference(result)))
    workflow["WFWorkflowActions"] = out.actions
    workflow["WFWorkflowImportQuestions"] = questions
    validate(workflow)
    return workflow


def write_workflow(workflow: dict, output: Path, *, sign: bool, name: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    data = plistlib.dumps(workflow, sort_keys=True)
    if sign:
        executable = shutil.which("shortcuts")
        if not executable:
            raise RuntimeError("签名需要 macOS 的 shortcuts CLI；其他系统可生成待签名 plist。")
        with tempfile.TemporaryDirectory(prefix="dashboard-shortcut-") as temporary:
            unsigned = Path(temporary) / f"{name}.shortcut"
            unsigned.write_bytes(data)
            subprocess.run([executable, "sign", "--mode", "anyone", "--input", str(unsigned), "--output", str(output)], check=True, timeout=60)
    else:
        output.write_bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser(description=f"构建无凭据的招行记账 {VERSION} 模板，不修改已安装快捷指令。")
    parser.add_argument("--sign", action="store_true", help="使用 macOS shortcuts sign 生成可导入文件")
    parser.add_argument("--output", type=Path, help="生成文件路径")
    args = parser.parse_args()
    output = args.output or (ROOT / f"public/shortcuts/cmb-ledger-{VERSION}.shortcut" if args.sign
                             else ROOT / f"work/shortcuts/cmb-ledger-{VERSION}.plist")
    if args.sign and not shutil.which("shortcuts"):
        parser.error("签名需要 macOS 的 shortcuts CLI；其他系统可省略 --sign 生成待签名 plist。")
    write_workflow(build_workflow(), output, sign=args.sign, name=f"招行记账 {VERSION}")
    print(f"已生成无凭据模板：{output}")
    print("尚未安装或运行。导入后需配置正式服务地址及设备令牌，再做实际设备验收。")


if __name__ == "__main__":
    main()
