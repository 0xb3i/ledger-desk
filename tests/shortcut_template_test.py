import copy
import importlib.util
import plistlib
import re
import secrets
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_shortcut", ROOT / "scripts/build-shortcut.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def params(action):
    return action["WFWorkflowActionParameters"]


def named(actions, name):
    return next(item for item in actions if params(item)["UUID"] == builder.identifier(name))


class ShortcutTemplateTest(unittest.TestCase):
    def setUp(self):
        self.workflow = builder.build_workflow()
        self.actions = self.workflow["WFWorkflowActions"]

    def test_build_is_deterministic_and_keeps_reviewed_parser(self):
        self.assertEqual(plistlib.dumps(self.workflow), plistlib.dumps(builder.build_workflow()))
        source = plistlib.loads(builder.SOURCE.read_bytes())
        current = {params(item)["UUID"]: item for item in self.actions}
        for item in source["ParserActions"]:
            self.assertEqual(item, current[params(item)["UUID"]])

    def test_import_questions_target_empty_configuration_actions(self):
        for question in self.workflow["WFWorkflowImportQuestions"]:
            self.assertEqual(question["Category"], "Parameter")
            action = self.actions[question["ActionIndex"]]
            self.assertEqual(action["WFWorkflowActionIdentifier"], "is.workflow.actions.gettext")
            self.assertEqual(params(action)[question["ParameterKey"]], builder.text(""))

    def test_text_replacement_inputs_use_native_text_parameter_serialization(self):
        # WFTextInputParameter rejects a bare WFTextTokenAttachment and silently
        # drops the input. Text replacements require an interpolated text value.
        replacements = [action for action in self.actions if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.text.replace"]
        self.assertTrue(replacements)
        for action in replacements:
            value = params(action)["WFInput"]
            with self.subTest(action=params(action)["UUID"]):
                self.assertEqual(value["WFSerializationType"], "WFTextTokenString")
                self.assertIn("\ufffc", value["Value"]["string"])
                self.assertTrue(value["Value"]["attachmentsByRange"])

    def test_only_new_endpoint_receives_text_amount_and_device_credentials(self):
        network = [item for item in self.actions if item["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl"]
        self.assertEqual(len(network), 1)
        request = params(network[0])
        self.assertEqual(request["WFHTTPMethod"], "POST")
        self.assertEqual(request["WFURL"]["Value"]["string"], "\ufffc/api/ingest/cmb")
        headers = {item["WFKey"]["Value"]["string"]: item["WFValue"] for item in request["WFHTTPHeaders"]["Value"]["WFDictionaryFieldValueItems"]}
        self.assertEqual(headers["Authorization"], builder.text("Bearer ", builder.variable("设备令牌")))
        self.assertEqual(headers["Idempotency-Key"], builder.text(builder.variable("本次请求身份")))
        fields = {item["WFKey"]["Value"]["string"]: item for item in request["WFJSONValues"]["Value"]["WFDictionaryFieldValueItems"]}
        for field in ["amount", "balance"]:
            self.assertEqual(fields[field]["WFItemType"], 0)
        self.assertEqual(fields["parser_version"]["WFValue"], builder.text("1.1.5"))
        self.assertNotIn("raw_text", fields)

    def test_random_draws_produce_rfc_uuid_v4_format_before_one_submission(self):
        chars = params(named(self.actions, "uuid/hex"))["WFItems"]
        variants = params(named(self.actions, "uuid/variants"))["WFItems"]
        self.assertEqual(chars, list("0123456789abcdef"))
        self.assertEqual(variants, list("89ab"))
        self.assertEqual(params(named(self.actions, "uuid/repeat"))["WFRepeatCount"], 32)
        formatted = params(named(self.actions, "uuid/format"))
        seen = set()
        for _ in range(100):
            raw = "".join(secrets.choice("0123456789abcdef") for _ in range(32))
            replacement = formatted["WFReplaceTextReplace"]["Value"]["string"].replace("\ufffc", secrets.choice("89ab"))
            replacement = re.sub(r"\$(\d)", lambda item: r"\g<" + item.group(1) + ">", replacement)
            result = re.sub(formatted["WFReplaceTextFind"], replacement, raw)
            parsed = uuid.UUID(result)
            self.assertEqual(parsed.version, 4)
            self.assertEqual(parsed.variant, uuid.RFC_4122)
            seen.add(result)
        self.assertEqual(len(seen), 100)
        self.assertLess(self.actions.index(named(self.actions, "request/id")), self.actions.index(named(self.actions, "request/send")))

    def test_success_assignments_are_nested_under_nonempty_id_and_exact_status(self):
        status_text = named(self.actions, "response/status-text")
        self.assertEqual(status_text["WFWorkflowActionIdentifier"], "is.workflow.actions.gettext")
        self.assertEqual(params(status_text)["WFTextActionText"], builder.text(builder.reference(named(self.actions, "response/status"))))
        for status in ("created", "duplicate", "needs_review"):
            condition = params(named(self.actions, f"response/{status}/if"))
            self.assertEqual(condition["WFInput"]["Variable"], builder.attachment(builder.reference(status_text)))
        active = []
        accepted = set()
        has_id_group = params(named(self.actions, "response/has-id/if"))["GroupingIdentifier"]
        id_length = named(self.actions, "response/id-length")
        self.assertEqual(params(id_length)["WFCountType"], "Characters")
        self.assertEqual(params(id_length)["Input"], builder.attachment(builder.reference(named(self.actions, "response/id-trim"))))
        id_condition = params(named(self.actions, "response/has-id/if"))
        self.assertEqual(id_condition["WFCondition"], 2)
        self.assertEqual(id_condition["WFNumberValue"], 0)
        self.assertEqual(id_condition["WFInput"]["Variable"], builder.attachment(builder.reference(id_length)))
        response_start = self.actions.index(named(self.actions, "response/has-id/if"))
        for action in self.actions[response_start:]:
            value = params(action)
            if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.conditional":
                mode = value["WFControlFlowMode"]
                if mode == 0:
                    active.append(value)
                elif mode == 2:
                    active.pop()
            if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.gettext":
                literal = value["WFTextActionText"]["Value"]["string"]
                if literal in {"created", "duplicate", "needs_review"}:
                    self.assertEqual(active[0]["GroupingIdentifier"], has_id_group)
                    self.assertEqual(active[-1]["WFCondition"], 4)
                    self.assertEqual(active[-1]["WFConditionalActionString"], literal)
                    accepted.add(literal)
        self.assertEqual(accepted, {"created", "duplicate", "needs_review"})

    def test_validation_rejects_embedded_credentials_and_dangling_references(self):
        unsafe = copy.deepcopy(self.workflow)
        unsafe["WFWorkflowActions"][1]["WFWorkflowActionParameters"]["WFTextActionText"] = builder.text("pd_device_" + "a" * 43)
        with self.assertRaisesRegex(ValueError, "凭据"):
            builder.validate(unsafe)
        dangling = copy.deepcopy(self.workflow)
        dangling["WFWorkflowActions"].pop(self.actions.index(named(self.actions, "uuid/format")))
        with self.assertRaisesRegex(ValueError, "悬空"):
            builder.validate(dangling)


if __name__ == "__main__":
    unittest.main()
