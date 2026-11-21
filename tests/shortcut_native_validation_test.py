import copy
import importlib.util
import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_shortcut_validator", ROOT / "scripts/validate-shortcut-native.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swift"), "需要 macOS 和 Swift 原生参数接口")
class NativeShortcutParametersTest(unittest.TestCase):
    def test_current_public_template_roundtrips_native_variable_parameters(self):
        workflow = validator.public_workflow()
        result = validator.run_native_validation(workflow)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("NATIVE_PARAMETERS_OK", result.stdout)
        self.assertIn("textReplaceInputs=", result.stdout)
        comparisons = sum("WFConditionalActionString" in action["WFWorkflowActionParameters"]
                          for action in workflow["WFWorkflowActions"])
        self.assertGreater(comparisons, 0)
        self.assertIn(f"conditionValues={comparisons}", result.stdout)

    def test_rejects_bare_attachments_in_each_affected_text_input(self):
        workflow = validator.public_workflow()
        names = {"整理后的服务地址", "服务根地址", "整理后的设备令牌", "本次请求UUID", "非空账目ID"}
        affected = [index for index, action in enumerate(workflow["WFWorkflowActions"])
                    if action["WFWorkflowActionParameters"].get("CustomOutputName") in names]
        self.assertEqual(len(affected), 5)
        for index in affected:
            with self.subTest(action=index):
                invalid = copy.deepcopy(workflow)
                params = invalid["WFWorkflowActions"][index]["WFWorkflowActionParameters"]
                self.assertEqual(params["WFInput"]["WFSerializationType"], "WFTextTokenString")
                reference = next(iter(params["WFInput"]["Value"]["attachmentsByRange"].values()))
                params["WFInput"] = {"Value": reference, "WFSerializationType": "WFTextTokenAttachment"}
                result = validator.run_native_validation(invalid)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("PARAMETER_STATE_NIL", result.stderr)

    def test_rejects_receipt_conditions_without_text_normalization(self):
        workflow = validator.public_workflow()
        actions = workflow["WFWorkflowActions"]
        raw_status = next(action["WFWorkflowActionParameters"] for action in actions
                          if action["WFWorkflowActionParameters"].get("CustomOutputName") == "账本响应状态")
        text_status = next(action["WFWorkflowActionParameters"] for action in actions
                           if action["WFWorkflowActionParameters"].get("CustomOutputName") == "账本响应状态文本")
        conditions = [action["WFWorkflowActionParameters"] for action in actions
                      if action["WFWorkflowActionParameters"].get("WFConditionalActionString")
                      in {"created", "duplicate", "needs_review"}]
        self.assertEqual(len(conditions), 3)
        for params in conditions:
            reference = params["WFInput"]["Variable"]["Value"]
            self.assertEqual(reference["OutputUUID"], text_status["UUID"])
            reference["OutputUUID"] = raw_status["UUID"]
            reference["OutputName"] = raw_status["CustomOutputName"]
        workflow["WFWorkflowActions"] = [action for action in actions
                                         if action["WFWorkflowActionParameters"]["UUID"] != text_status["UUID"]]
        result = validator.run_native_validation(workflow)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stderr.count("CONDITIONAL_COMPARISON_MISSING"), 3, result.stderr)


if __name__ == "__main__":
    unittest.main()
