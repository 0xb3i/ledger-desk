#!/usr/bin/env python3
"""Build the public Feishu relay shortcut without reading personal credentials.

The reviewed bank parser and native UUID actions are shared with the direct
ledger shortcut. A successful webhook receipt means accepted, not recorded.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("cmb_shortcut_builder", HERE / "build-shortcut.py")
common = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(common)

VERSION = "1.3.1"
NAME = f"招行记账 飞书中转 {VERSION}"
ROOT, SOURCE = common.ROOT, common.SOURCE
Workflow = common.Workflow
identifier, variable, reference = common.identifier, common.variable, common.reference
attachment, text, dictionary = common.attachment, common.text, common.dictionary

# Check the functional endpoint and trusted service domain rather than any
# tenant or secret event identifier. The existing flow uses /base/workflow/.
WEBHOOK_PATTERN = r"^https://(?:[A-Za-z0-9-]+\.)*(?:feishu\.cn|larkoffice\.com|larksuite\.com)/base/(?:workflow|automation)/webhook/event/[A-Za-z0-9_-]+/?$"
TOKEN_PATTERN = r"^[A-Za-z0-9._~+/-]{8,1024}={0,2}$"
ACCEPTED_MESSAGE = "飞书已受理，请在飞书核对是否入表；轻记会在电脑联网时自动同步。"
UNCONFIRMED_MESSAGE = "未确认飞书已受理。原邮件仍在，请先检查飞书表中的记录，再决定是否重新运行。"


def validate(workflow: dict) -> None:
    common.validate_structure(workflow)
    common.validate_empty_configuration(workflow)
    for value in common.strings(workflow):
        # The regex pattern above is not a concrete URL. No concrete URL, static
        # Bearer, app secret, or direct-ledger credential belongs in this file.
        if re.search(r"https?://[A-Za-z0-9][A-Za-z0-9.-]*(?:/|\b)|Bearer [A-Za-z0-9._~+/-]{8,}|pd_device_[A-Za-z0-9_-]{43}", value, re.I):
            raise ValueError("公开飞书模板包含具体服务地址或凭据，拒绝生成")
    actions = workflow["WFWorkflowActions"]
    request = next(action["WFWorkflowActionParameters"] for action in actions
                   if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl")
    if request["WFURL"] != text(variable("飞书Webhook地址")):
        raise ValueError("飞书提交必须使用导入配置的 Webhook 地址")
    fields = {item["WFKey"]["Value"]["string"]: item
              for item in request["WFJSONValues"]["Value"]["WFDictionaryFieldValueItems"]}
    if fields.get("request_id", {}).get("WFValue") != text(variable("本次请求身份")):
        raise ValueError("飞书提交必须携带本次运行固定的请求身份")
    for name in ("amount", "balance"):
        if fields[name]["WFItemType"] != 3 or fields[name + "_text"]["WFItemType"] != 0:
            raise ValueError("飞书金额必须同时保留兼容数字字段和精确文本字段")


def request_fields(out: Workflow, source: dict) -> dict:
    fields = copy.deepcopy(source["RequestFields"])
    items = fields["Value"]["WFDictionaryFieldValueItems"]
    by_name = {item["WFKey"]["Value"]["string"]: item for item in items}
    # Existing Feishu tables use numeric columns. Keep that wire contract, but
    # preserve the parser's decimal text separately for exact backend storage.
    for key, label in (("amount", "上传金额"), ("balance", "上传余额")):
        precise = copy.deepcopy(by_name[key])
        precise["WFKey"] = text(key + "_text")
        items.append(precise)
        number = out.add(f"feishu/{key}/number", "number", label,
                         WFNumberActionNumber=copy.deepcopy(by_name[key]["WFValue"]))
        by_name[key]["WFItemType"] = 3
        by_name[key]["WFValue"] = text(reference(number))
    items.extend(dictionary({"request_id": variable("本次请求身份")})["Value"]["WFDictionaryFieldValueItems"])
    return fields


def build_workflow(source_path: Path = SOURCE) -> dict:
    source = common.load_parser(source_path)
    workflow = copy.deepcopy(source["WorkflowMetadata"])
    out = Workflow()
    out.add("instructions", "comment", WFCommentActionText=(
        f"{NAME}\n"
        "导入时填写飞书多维表格工作流的 HTTPS Webhook 地址和专用 Bearer 令牌，不要填写 App Secret。配置后的个人副本请勿分享。\n"
        "输入为一封招行交易邮件正文；解析成功后仅向飞书提交一次，不要求手机连接看板。\n"
        "沿用 1.1.5 解析器，兼容现有飞书入表流程。跨年历史邮件需核对年份。\n"
        "request_id 在本次运行保持不变。code 为 0 仅代表飞书受理；请在飞书核对是否入表。电脑上的轻记会自动读取飞书新账单。\n"
        "本模板没有跨运行离线队列，也不会自动重试网络错误。网络错误会由系统中止；原邮件仍在，请先核对飞书记录，不要重复触发已受理的邮件。"
    ))
    questions = []
    for name, prompt in (
        ("飞书Webhook地址", "填写飞书多维表格工作流提供的完整 HTTPS Webhook 地址。"),
        ("Webhook令牌", "填写此 Webhook 的专用 Bearer 令牌，不含 Bearer 前缀；不要填写 App Secret。"),
    ):
        questions.append({"ActionIndex": len(out.actions), "Category": "Parameter", "ParameterKey": "WFTextActionText", "Text": prompt})
        value = out.add(f"config/{name}", "gettext", name, WFTextActionText=text(""))
        clean = out.add(f"config/{name}/trim", "text.replace", f"整理后的{name}", WFInput=text(reference(value)),
                        WFReplaceTextFind=r"^\s+|\s+$", WFReplaceTextReplace="", WFReplaceTextRegularExpression=True,
                        WFReplaceTextCaseSensitive=True)
        out.add(f"config/{name}/set", "setvariable", WFVariableName=name, WFInput=attachment(reference(clean)))
    endpoint = out.add("config/webhook/check", "text.match", "有效飞书Webhook地址", text=text(variable("飞书Webhook地址")),
                       WFMatchTextPattern=WEBHOOK_PATTERN, WFMatchTextCaseSensitive=True)
    out.invalid_configuration("config/webhook", endpoint, "请填写飞书多维表格工作流提供的完整 HTTPS Webhook 地址，再运行记账。")
    token = out.add("config/token/check", "text.match", "有效Webhook令牌", text=text(variable("Webhook令牌")),
                    WFMatchTextPattern=TOKEN_PATTERN, WFMatchTextCaseSensitive=True)
    out.invalid_configuration("config/token", token, "请填写 Webhook 专用 Bearer 令牌，不含 Bearer 前缀，再运行记账。")
    out.actions.extend(copy.deepcopy(source["ParserActions"]))
    common.add_request_identity(out)
    fields = request_fields(out, source)
    headers = dictionary({"Authorization": "", "Content-Type": "application/json"})
    headers["Value"]["WFDictionaryFieldValueItems"][0]["WFValue"] = text("Bearer ", variable("Webhook令牌"))
    request = out.add("request/send", "downloadurl", "飞书响应", WFURL=text(variable("飞书Webhook地址")),
                      WFHTTPMethod="POST", WFHTTPBodyType="JSON", ShowHeaders=True, WFHTTPHeaders=headers, WFJSONValues=fields)
    response = out.add("response/dictionary", "detect.dictionary", "飞书响应词典", WFInput=attachment(reference(request)))
    code = out.add("response/code", "getvalueforkey", "飞书受理码", WFInput=attachment(reference(response)),
                   WFGetDictionaryValueType="Value", WFDictionaryKey="code")
    code_text = out.add("response/code-text", "gettext", "飞书受理码文本", WFTextActionText=text(reference(code)))
    clean_code = out.add("response/code-trim", "text.replace", "整理后的受理码", WFInput=text(reference(code_text)),
                         WFReplaceTextFind=r"^\s+|\s+$", WFReplaceTextReplace="", WFReplaceTextRegularExpression=True,
                         WFReplaceTextCaseSensitive=True)
    numeric_code = out.add("response/code-valid", "text.match", "有效受理码", text=text(reference(clean_code)),
                           WFMatchTextPattern=r"^-?[0-9]+$", WFMatchTextCaseSensitive=True)
    out.set("提交状态", "unconfirmed")
    out.set("提交说明", UNCONFIRMED_MESSAGE)
    valid = out.begin("response/valid-code", reference(numeric_code), 100)
    number = out.add("response/code-number", "number", "受理码数值", WFNumberActionNumber=text(reference(clean_code)))
    accepted = out.begin("response/accepted", reference(number), 4, number=0)
    out.set("提交状态", "accepted")
    out.set("提交说明", ACCEPTED_MESSAGE)
    out.end("response/accepted", accepted)
    out.end("response/valid-code", valid)
    result = out.add("result", "dictionary", "飞书提交结果", WFItems=dictionary({
        "status": variable("提交状态"), "message": variable("提交说明"), "request_id": variable("本次请求身份"),
        "shortcut_version": VERSION, "parser_version": source["ParserVersion"],
    }))
    manual = out.begin("result/manual", variable("手动调试"), 4, "是")
    out.add("result/show", "showresult", Text=text(variable("提交说明")))
    out.end("result/manual", manual)
    out.add("result/return", "output", WFOutput=text(reference(result)))
    workflow["WFWorkflowActions"] = out.actions
    workflow["WFWorkflowImportQuestions"] = questions
    validate(workflow)
    return workflow


def main() -> None:
    parser = argparse.ArgumentParser(description=f"构建无凭据的{NAME}公开模板，不修改已安装快捷指令。")
    parser.add_argument("--sign", action="store_true", help="使用 macOS shortcuts sign 生成可导入文件")
    parser.add_argument("--output", type=Path, help="生成文件路径")
    args = parser.parse_args()
    output = args.output or (ROOT / f"public/shortcuts/cmb-feishu-{VERSION}.shortcut" if args.sign
                             else ROOT / f"work/shortcuts/cmb-feishu-{VERSION}.plist")
    try:
        common.write_workflow(build_workflow(), output, sign=args.sign, name=NAME)
    except RuntimeError as error:
        parser.error(str(error))
    print(f"已生成无凭据飞书中转模板：{output}")
    print("尚未安装或运行。请配置专用 Webhook，再核验飞书入表与后台同步。")


if __name__ == "__main__":
    main()
