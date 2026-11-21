import Foundation
import ObjectiveC
import Darwin

// The public template is instantiated in memory so ActionKit can resolve output
// types for dynamic parameters. No controller, runner, installed library or UI
// is used, and the workflow is never executed.
func invoke(_ object: NSObject, _ selector: String, _ argument: Any? = nil) -> AnyObject? {
    let method = NSSelectorFromString(selector)
    guard object.responds(to: method) else { return nil }
    if selector.contains(":") { return object.perform(method, with: argument)?.takeUnretainedValue() }
    return object.perform(method)?.takeUnretainedValue()
}

func references(_ value: Any) -> [String: Int] {
    var result: [String: Int] = [:]
    func collect(_ item: Any) {
        if let object = item as? [String: Any] {
            if object["Type"] as? String == "ActionOutput", let id = object["OutputUUID"] as? String {
                result["output:" + id, default: 0] += 1
            } else if object["Type"] as? String == "Variable", let name = object["VariableName"] as? String {
                result["variable:" + name, default: 0] += 1
            }
            object.values.forEach(collect)
        } else if let array = item as? [Any] { array.forEach(collect) }
    }
    collect(value)
    return result
}

func fail(_ message: String, status: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(status)
}

guard dlopen("/System/Library/PrivateFrameworks/WorkflowKit.framework/WorkflowKit", RTLD_LAZY) != nil,
      dlopen("/System/Library/PrivateFrameworks/ActionKit.framework/ActionKit", RTLD_LAZY) != nil,
      let registryType = NSClassFromString("WFActionRegistry"),
      let workflowType = NSClassFromString("WFWorkflow") else {
    fail("NATIVE_UNAVAILABLE 当前系统不能加载 WorkflowKit / ActionKit 原生参数接口。", status: 3)
}
let registryClass: AnyObject = registryType
guard class_getClassMethod(registryType, NSSelectorFromString("sharedRegistry")) != nil else {
    fail("NATIVE_UNAVAILABLE WorkflowKit 未提供共享动作定义注册表。", status: 3)
}
guard let registry = registryClass.perform(NSSelectorFromString("sharedRegistry"))?.takeUnretainedValue() as? NSObject,
      registry.responds(to: NSSelectorFromString("createActionWithIdentifier:serializedParameters:")) else {
    fail("NATIVE_UNAVAILABLE WorkflowKit 没有提供所需参数创建接口。", status: 3)
}
let workflow: [String: Any]
do {
    guard let value = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any] else {
        fail("INVALID_WORKFLOW 输入必须是公开 workflow 对象。")
    }
    workflow = value
} catch { fail("INVALID_WORKFLOW 无法解析输入；未输出输入内容。") }
guard let serializedActions = workflow["WFWorkflowActions"] as? [[String: Any]] else {
    fail("INVALID_WORKFLOW 缺少动作列表。")
}

let structuralKeys: Set<String> = ["UUID", "CustomOutputName", "GroupingIdentifier", "WFControlFlowMode", "ShowHeaders"]
var actions: [NSObject] = []
var unavailable: [String: Int] = [:]
var checkedParameters = 0
var checkedReferences = 0
var checkedReplaceInputs = 0
var checkedConditionValues = 0
var failures: [String] = []

for (index, serialized) in serializedActions.enumerated() {
    guard let identifier = serialized["WFWorkflowActionIdentifier"] as? String,
          let parameters = serialized["WFWorkflowActionParameters"] as? [String: Any],
          let action = registry.perform(NSSelectorFromString("createActionWithIdentifier:serializedParameters:"), with: identifier, with: parameters)?.takeUnretainedValue() as? NSObject else {
        fail("INVALID_ACTION 无法创建第 \(index) 个动作的原生参数对象。")
    }
    actions.append(action)
}

// Actions need a shared workflow to resolve the content classes of an earlier
// output. Inspecting each condition in isolation misses its dynamic value field.
let workflowClass: AnyObject = workflowType
guard let nativeWorkflow = workflowClass.perform(NSSelectorFromString("new"))?.takeRetainedValue() as? NSObject,
      nativeWorkflow.responds(to: NSSelectorFromString("setActions:")) else {
    fail("NATIVE_UNAVAILABLE 当前系统没有提供内存工作流关联接口。", status: 3)
}
_ = invoke(nativeWorkflow, "setActions:", actions)

for (index, serialized) in serializedActions.enumerated() {
    let identifier = serialized["WFWorkflowActionIdentifier"] as! String
    let parameters = serialized["WFWorkflowActionParameters"] as! [String: Any]
    let action = actions[index]
    if identifier == "is.workflow.actions.conditional", let comparison = parameters["WFConditionalActionString"] {
        let selector = NSSelectorFromString("visibleParametersWithProcessing:")
        guard action.responds(to: selector) else {
            fail("NATIVE_UNAVAILABLE 当前系统没有提供条件动作的动态参数接口。", status: 3)
        }
        typealias VisibleParameters = @convention(c) (AnyObject, Selector, Bool) -> AnyObject?
        let readVisible = unsafeBitCast(action.method(for: selector), to: VisibleParameters.self)
        guard let visible = readVisible(action, selector, false) as? [NSObject] else {
            fail("NATIVE_UNAVAILABLE 当前系统没有返回条件动作的动态参数列表。", status: 3)
        }
        let hasValue = visible.contains { invoke($0, "key") as? String == "value" }
        let state = invoke(action, "parameterStateForKey:", "value") as? NSObject
        let roundtrip = state.flatMap { invoke($0, "serializedRepresentation") }
        if !hasValue {
            failures.append("CONDITIONAL_COMPARISON_MISSING action=\(index) \(identifier) key=value")
        } else if roundtrip == nil {
            failures.append("CONDITIONAL_COMPARISON_STATE_NIL action=\(index) \(identifier) key=value")
        } else if let expected = comparison as? String, roundtrip as? String != expected {
            failures.append("CONDITIONAL_COMPARISON_CHANGED action=\(index) \(identifier) key=value")
        } else if references(roundtrip!) != references(comparison) {
            failures.append("VARIABLE_REFERENCE_LOST action=\(index) \(identifier) key=value")
        } else {
            checkedConditionValues += 1
        }
    }
    let definition = invoke(action, "definition") as? NSObject
    guard let nativeDefinitions = definition.flatMap({ invoke($0, "objectForKey:", "Parameters") }) as? [NSObject] else {
        unavailable[identifier, default: 0] += 1
        continue
    }
    var definitionsByKey: [String: NSObject] = [:]
    for parameterDefinition in nativeDefinitions {
        if let key = invoke(parameterDefinition, "objectForKey:", "Key") as? String { definitionsByKey[key] = parameterDefinition }
    }
    for key in parameters.keys.sorted() where !structuralKeys.contains(key) {
        guard let parameter = invoke(action, "parameterForKey:", key) as? NSObject else {
            failures.append("UNKNOWN_PARAMETER action=\(index) \(identifier) key=\(key)")
            continue
        }
        checkedParameters += 1
        let expectedReferences = references(parameters[key]!)
        let state = invoke(action, "parameterStateForKey:", key) as? NSObject
        if !expectedReferences.isEmpty {
            guard let state, let roundtrip = invoke(state, "serializedRepresentation") else {
                failures.append("PARAMETER_STATE_NIL action=\(index) \(identifier) key=\(key) class=\(NSStringFromClass(type(of: parameter)))")
                continue
            }
            if references(roundtrip) != expectedReferences {
                failures.append("VARIABLE_REFERENCE_LOST action=\(index) \(identifier) key=\(key)")
                continue
            }
            checkedReferences += expectedReferences.values.reduce(0, +)
            if identifier == "is.workflow.actions.text.replace" && key == "WFInput" { checkedReplaceInputs += 1 }
        }
        if NSStringFromClass(type(of: parameter)) == "WFEnumerationParameter",
           let raw = parameters[key] as? String, let nativeDefinition = definitionsByKey[key],
           let allowed = invoke(nativeDefinition, "objectForKey:", "Items") as? [String], !allowed.contains(raw) {
            failures.append("INVALID_ENUM action=\(index) \(identifier) key=\(key)")
        }
    }
}

for question in workflow["WFWorkflowImportQuestions"] as? [[String: Any]] ?? [] {
    guard question["Category"] as? String == "Parameter",
          let index = question["ActionIndex"] as? Int, actions.indices.contains(index),
          let key = question["ParameterKey"] as? String,
          invoke(actions[index], "parameterForKey:", key) != nil else {
        failures.append("INVALID_IMPORT_QUESTION 导入问题没有指向有效的原生参数。")
        continue
    }
}
if checkedReplaceInputs == 0 {
    failures.append("NATIVE_COVERAGE_MISSING 未完成任何 text.replace 输入的原生变量回读。")
}
if checkedConditionValues == 0 {
    failures.append("NATIVE_COVERAGE_MISSING 未完成任何条件比较值的原生动态参数回读。")
}
if !unavailable.isEmpty {
    print("NATIVE_COVERAGE_LIMIT 以下动作未提供通用参数定义；条件比较值另行验证和计数：")
    for identifier in unavailable.keys.sorted() { print("  \(identifier): \(unavailable[identifier]!) 个动作") }
}
if !failures.isEmpty {
    failures.forEach { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
    fail("NATIVE_PARAMETERS_FAILED 参数回读失败；未安装或执行工作流。")
}
print("NATIVE_PARAMETERS_OK actions=\(actions.count) parameters=\(checkedParameters) references=\(checkedReferences) textReplaceInputs=\(checkedReplaceInputs) conditionValues=\(checkedConditionValues)")
print("检查范围为可用原生定义的参数、变量及条件比较值回读，不代表快捷指令已实际执行。")
