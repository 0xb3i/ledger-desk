import hashlib
import importlib.util
import json
import plistlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("parser_builder", ROOT / "scripts/build-shortcut.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def params(action):
    return action["WFWorkflowActionParameters"]


class WechatTransferParserTest(unittest.TestCase):
    def setUp(self):
        self.source = builder.load_parser()
        actions = self.source["ParserActions"]
        start = next(i for i, action in enumerate(actions) if params(action)["UUID"] == builder.identifier("parser/wechat-transfer/comment"))
        end = next(i for i, action in enumerate(actions) if params(action)["UUID"] == builder.identifier("parser/wechat-transfer/type-guard/end"))
        self.fragment = actions[start:end + 1]
        self.description = next(action for action in actions if params(action).get("CustomOutputName") == "交易描述")

    def normalize(self, description, kind, direction):
        # Execute the small production normalization fragment with synthetic
        # values. The native parameter roundtrip separately checks serialization.
        variables = {"记账类型": kind, "记账类型名称": "原类型", "资金方向": direction}
        outputs = {params(self.description)["UUID"]: description}
        source_direction = next(action for action in self.source["ParserActions"] if params(action).get("CustomOutputName") == "资金方向")
        outputs[params(source_direction)["UUID"]] = direction

        def value(item):
            if isinstance(item, str):
                return item
            if "Variable" in item:
                return value(item["Variable"])
            if item.get("Type") == "Variable":
                return variables[item["VariableName"]]
            if item.get("Type") == "ActionOutput":
                return outputs[item["OutputUUID"]]
            if item.get("WFSerializationType") == "WFTextTokenString":
                text = item["Value"]
                result = text["string"]
                for reference in text.get("attachmentsByRange", {}).values():
                    result = result.replace("\ufffc", str(value(reference)), 1)
                return result
            if "Value" in item:
                return value(item["Value"])
            raise AssertionError(f"Unsupported fixture parameter: {item}")

        active = []
        for action in self.fragment:
            action_id, p = action["WFWorkflowActionIdentifier"], params(action)
            if action_id.endswith("conditional"):
                if p["WFControlFlowMode"] == 0:
                    if active and not all(active):
                        active.append(False)
                    else:
                        actual = value(p["WFInput"])
                        active.append(bool(actual) if p["WFCondition"] == 100 else actual == p["WFConditionalActionString"])
                else:
                    active.pop()
            elif all(active):
                if action_id.endswith("text.match"):
                    outputs[p["UUID"]] = re.search(p["WFMatchTextPattern"], value(p["text"])) is not None
                elif action_id.endswith("gettext"):
                    outputs[p["UUID"]] = value(p["WFTextActionText"])
                elif action_id.endswith("setvariable"):
                    variables[p["WFVariableName"]] = value(p["WFInput"])
                elif not action_id.endswith("comment"):
                    raise AssertionError(f"Unexpected normalization action: {action_id}")
        return variables

    def test_bank_collection_rule_remains_credit_before_normalization(self):
        rules_action = next(action for action in self.source["ParserActions"] if params(action).get("CustomOutputName") == "交易规则配置")
        rules = json.loads(params(rules_action)["WFTextActionText"]["Value"]["string"])["rules"]
        for mail in (
            "您账户1234于11月01日20:21收款188.00元，余额69284.39（财付通-微信支付-微信转账）",
            "您账户1234于11月01日20:21收款188.00元，余额69284.39，备注：财付通-微信支付-微信转账",
        ):
            matches = [(rule, re.search(rule["pattern"], mail)) for rule in rules]
            matches = [(rule, match) for rule, match in matches if match]
            self.assertEqual(len(matches), 1)
            rule, match = matches[0]
            self.assertEqual(rule["type"], "credit")
            description = match.group(rule["description_group"])
            self.assertEqual(self.normalize(description, rule["type"], rule["direction"])["记账类型"], "transfer_in")

    def test_complete_transfer_uses_direction_and_preserves_descriptor(self):
        for description in ("微信转账", "财付通-微信支付-微信转账", " 财付通 － 微信支付 － 微信转账。 ", "微信转账．"):
            for kind in ("purchase", "refund", "credit", "transfer_out"):
                for direction, expected, label in (("inflow", "transfer_in", "转入"), ("outflow", "transfer_out", "转账转出")):
                    with self.subTest(description=description, kind=kind, direction=direction):
                        actual = self.normalize(description, kind, direction)
                        self.assertEqual(actual["记账类型"], expected)
                        self.assertEqual(actual["记账类型名称"], label)

    def test_refunds_failures_and_unrelated_transfer_mentions_remain_original(self):
        for description in ("微信转账退款", "微信转账失败退款", "财付通-微信支付-微信转账手续费退还", "朋友还款备注：微信转账", "商户退款", "财付通-其他支付-微信转账"):
            with self.subTest(description=description):
                self.assertEqual(self.normalize(description, "refund", "inflow")["记账类型"], "refund")
        for kind in ("salary", "wallet_withdrawal", "wallet_topup"):
            self.assertEqual(self.normalize("微信转账", kind, "inflow")["记账类型"], kind)

    def test_request_type_uses_normalized_variable_and_fingerprint_keeps_original_type(self):
        fields = {item["WFKey"]["Value"]["string"]: item["WFValue"] for item in self.source["RequestFields"]["Value"]["WFDictionaryFieldValueItems"]}
        self.assertEqual(fields["transaction_type"], builder.text(builder.variable("记账类型")))
        actions = self.source["ParserActions"]
        fingerprint = next(action for action in actions if params(action).get("CustomOutputName") == "交易指纹原文")
        original_type = next(action for action in actions if params(action).get("CustomOutputName") == "交易类型")
        refs = params(fingerprint)["WFTextActionText"]["Value"]["attachmentsByRange"].values()
        self.assertIn(params(original_type)["UUID"], [ref.get("OutputUUID") for ref in refs])
        self.assertLess(actions.index(fingerprint), actions.index(self.fragment[0]))
        fingerprint_actions = actions[actions.index(fingerprint):actions.index(fingerprint) + 3]
        self.assertEqual(hashlib.sha256(plistlib.dumps(fingerprint_actions, sort_keys=True)).hexdigest(),
                         "77fa45db0630abb2d431e6420f4241da6eec6687d27b7999a05095e57ca53abd")
        self.assertEqual(self.source["ParserVersion"], "1.1.5")


if __name__ == "__main__":
    unittest.main()
