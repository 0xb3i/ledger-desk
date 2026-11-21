import copy
import importlib.util
import plistlib
import re
import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("feishu_builder", ROOT / "scripts/build-feishu-shortcut.py")
validator = load("native_validator", ROOT / "scripts/validate-shortcut-native.py")
runtime = load("feishu_runtime", ROOT / "tests/native_feishu_shortcut_smoke.py")


def params(action):
    return action["WFWorkflowActionParameters"]


class FeishuShortcutTest(unittest.TestCase):
    def setUp(self):
        self.workflow = builder.build_workflow()
        self.actions = self.workflow["WFWorkflowActions"]
        self.named = {params(action)["UUID"]: action for action in self.actions}

    def named_params(self, name):
        return params(self.named[builder.identifier(name)])

    def test_reuses_reviewed_parser_and_builds_deterministically(self):
        self.assertEqual(plistlib.dumps(self.workflow), plistlib.dumps(builder.build_workflow()))
        for action in builder.common.load_parser()["ParserActions"]:
            self.assertEqual(action, self.named[params(action)["UUID"]])

    def test_public_configuration_and_transport_contain_no_credentials(self):
        questions = self.workflow["WFWorkflowImportQuestions"]
        self.assertEqual(len(questions), 2)
        for question in questions:
            self.assertEqual(params(self.actions[question["ActionIndex"]])[question["ParameterKey"]], builder.text(""))
        request = self.named_params("request/send")
        self.assertEqual(request["WFHTTPMethod"], "POST")
        self.assertEqual(request["WFURL"], builder.text(builder.variable("飞书Webhook地址")))
        headers = {item["WFKey"]["Value"]["string"]: item["WFValue"]
                   for item in request["WFHTTPHeaders"]["Value"]["WFDictionaryFieldValueItems"]}
        self.assertEqual(headers["Authorization"], builder.text("Bearer ", builder.variable("Webhook令牌")))
        self.assertEqual(sum(action["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl" for action in self.actions), 1)

    def test_json_keeps_numeric_compatibility_and_exact_decimal_text(self):
        fields = {item["WFKey"]["Value"]["string"]: item
                  for item in self.named_params("request/send")["WFJSONValues"]["Value"]["WFDictionaryFieldValueItems"]}
        source_fields = {item["WFKey"]["Value"]["string"]: item
                         for item in builder.common.load_parser()["RequestFields"]["Value"]["WFDictionaryFieldValueItems"]}
        self.assertEqual(set(fields), set(source_fields) | {"request_id", "amount_text", "balance_text"})
        for key in ("amount", "balance"):
            self.assertEqual(fields[key]["WFItemType"], 3)
            self.assertEqual(fields[key + "_text"]["WFValue"], source_fields[key]["WFValue"])
            self.assertEqual(fields[key + "_text"]["WFItemType"], 0)
            conversion = self.named[builder.identifier(f"feishu/{key}/number")]
            self.assertEqual(conversion["WFWorkflowActionIdentifier"], "is.workflow.actions.number")
            self.assertEqual(params(conversion)["WFNumberActionNumber"], source_fields[key]["WFValue"])
            self.assertEqual(fields[key]["WFValue"], builder.text(builder.reference(conversion)))
        self.assertEqual(fields["request_id"]["WFValue"], builder.text(builder.variable("本次请求身份")))
        for key in set(source_fields) - {"amount", "balance"}:
            self.assertEqual(fields[key], source_fields[key])

    def test_endpoint_validation_accepts_tenants_and_rejects_lookalikes(self):
        accepted = (
            "https://example.larkoffice.com/base/workflow/webhook/event/example-event",
            "https://tenant.sg.larkoffice.com/base/workflow/webhook/event/example-event/",
            "https://example.feishu.cn/base/automation/webhook/event/example-event",
        )
        rejected = (
            "http://example.feishu.cn/base/workflow/webhook/event/example-event",
            "https://example.feishu.cn.evil.invalid/base/workflow/webhook/event/example-event",
            "https://evil.invalid/base/workflow/webhook/event/example-event",
            "https://user:password@example.feishu.cn/base/workflow/webhook/event/example-event",
            "https://example.larkoffice.com/base/table-example",
        )
        for url in accepted:
            self.assertRegex(url, builder.WEBHOOK_PATTERN)
        for url in rejected:
            self.assertIsNone(re.fullmatch(builder.WEBHOOK_PATTERN, url))

    def test_acceptance_requires_numeric_zero_inside_valid_code_guard(self):
        code_condition = self.named_params("response/accepted/if")
        self.assertEqual(code_condition["WFCondition"], 4)
        self.assertEqual(code_condition["WFNumberValue"], 0)
        self.assertEqual(code_condition["WFInput"]["Variable"], builder.attachment(builder.reference(self.named[builder.identifier("response/code-number")])))
        self.assertEqual(self.named_params("response/code-valid")["WFMatchTextPattern"], r"^-?[0-9]+$")
        active = []
        found = False
        for action in self.actions:
            value = params(action)
            if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.conditional":
                if value["WFControlFlowMode"] == 0:
                    active.append(value["GroupingIdentifier"])
                elif value["WFControlFlowMode"] == 2:
                    active.pop()
            if value.get("WFTextActionText") == builder.text("accepted"):
                self.assertEqual(active[-2:], [self.named_params("response/valid-code/if")["GroupingIdentifier"], code_condition["GroupingIdentifier"]])
                found = True
        self.assertTrue(found)
        result = self.named_params("result")["WFItems"]["Value"]["WFDictionaryFieldValueItems"]
        self.assertEqual({item["WFKey"]["Value"]["string"] for item in result}, {"status", "message", "request_id", "shortcut_version", "parser_version"})

    def test_validation_rejects_secrets_and_private_endpoints(self):
        for unsafe_value in ("https://tenant.larkoffice.com/base/workflow/webhook/event/private-example", "Bearer example-secret-token"):
            invalid = copy.deepcopy(self.workflow)
            params(invalid["WFWorkflowActions"][0])["WFCommentActionText"] = unsafe_value
            with self.assertRaisesRegex(ValueError, "凭据"):
                builder.validate(invalid)

    def test_native_fixture_is_network_free_and_preserves_numeric_fields(self):
        fixture = runtime.build_fixture()
        self.assertFalse(fixture["WFWorkflowImportQuestions"])
        self.assertNotIn("is.workflow.actions.downloadurl", [action["WFWorkflowActionIdentifier"] for action in fixture["WFWorkflowActions"]])
        runtime.runtime.validate_fixture(fixture)

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("swift"), "需要 macOS 原生参数接口")
    def test_feishu_template_roundtrips_native_parameters(self):
        result = validator.run_native_validation(validator.public_workflow("feishu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("NATIVE_PARAMETERS_OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
