import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readUtf8(file) {
  return readFile(file, "utf8");
}

function assertIncludes(text, needle, message) {
  assert(text.includes(needle), message);
}

function assertOrdered(text, first, second, message) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert(firstIndex >= 0, `${message}: missing first marker`);
  assert(secondIndex >= 0, `${message}: missing second marker`);
  assert(firstIndex < secondIndex, message);
}

async function main() {
  const bridge = await readUtf8("ui/src/runtimeBridge.ts");
  const app = await readUtf8("ui/src/App.tsx");

  assert(!bridge.includes("\uFFFD"), "runtimeBridge.ts must not contain UTF-8 replacement characters");
  assert(!app.includes("\uFFFD"), "App.tsx must not contain UTF-8 replacement characters");
  assert(!/(?:鏁版嵁|鏇存柊|鏃ユ湡)/.test(app), "App.tsx must not contain common UTF-8/GBK mojibake sequences");
  assertIncludes(app, "<h2>更新今日数据</h2>", "data update panel should render a valid UTF-8 title");
  assertIncludes(app, "<span>数据日期</span>", "data update panel should render a valid UTF-8 date label");

  assertIncludes(bridge, "export type HostDiagnostics", "runtime bridge should expose a host diagnostics type");
  assertIncludes(bridge, "host_diagnostics?: HostDiagnostics | null", "response_task should expose optional host_diagnostics");

  assertIncludes(app, "type HostDiagnostics", "App should consume HostDiagnostics from runtimeBridge");
  assertIncludes(app, "isGenericHostExitOnly", "App should identify generic Host CLI/Kimi ACP exit errors");
  assertIncludes(app, "userVisibleHostDiagnosticsText", "App should sanitize host diagnostics before rendering");
  assertIncludes(app, "collectHostDiagnosticLines", "App should collect nested diagnostic fields");
  assertIncludes(app, "hostDiagnosticValueKey", "App should restrict diagnostic fields considered user-visible");
  assertIncludes(app, "actionableHostDiagnosticText", "App should restrict diagnostics to provider/auth/quota/rate-limit/status reasons");
  assertIncludes(app, "command|args", "App diagnostics sanitizer should strip command/args lines");
  assertIncludes(app, "node_modules", "App diagnostics sanitizer should strip internal stack/path lines");
  assertIncludes(app, "[redacted]", "App diagnostics sanitizer should redact credentials");
  assertIncludes(app, "Authorization: Bearer <redacted>", "App diagnostics sanitizer should redact complete bearer credentials");
  assertIncludes(app, "access[_-]?token", "App diagnostics sanitizer should redact JSON and key-value access tokens");
  assertIncludes(app, "host_cli_json_parse_failed", "App must classify host JSON parser failures as internal diagnostics");
  assert(
    !app.includes("missing mandatory pinned_result") && !app.includes("unpublishable pinned_result"),
    "lineup materialization quality failures must not be promoted to whole-answer UI failures",
  );
  assert(!app.includes("host response correction failed"), "retired format-correction failures must not remain in UI delivery diagnostics");
  assertIncludes(app, "request_id (?:does not match|mismatch)", "App must classify Host request identity failures separately from game-rule conflicts");
  assertIncludes(app, "conflicts with current game rules|violates game_rule_contract", "App must retain a specific current-game-rule conflict message");
  assertOrdered(
    app,
    "if (/request_id (?:does not match|mismatch)|request_hash (?:does not match|mismatch)|mode mismatch|request identity/i.test(text))",
    "if (/conflicts with current game rules|violates game_rule_contract/i.test(text))",
    "Host delivery identity failures must not be mislabeled as game-rule conflicts",
  );

  assertOrdered(
    app,
    "if (isGenericHostExitOnly(text))",
    "if (visible && !genericExitOnly) return visible;",
    "host diagnostics should only override generic exit-only errors before preserving non-generic visible errors",
  );
  assertIncludes(
    app,
    "const diagnosticText = userVisibleHostDiagnosticsText(diagnostics);\n    if (diagnosticText) return diagnosticText;",
    "generic exit-only errors should prefer sanitized host diagnostics",
  );
  assertIncludes(
    app,
    "if (visible && !genericExitOnly) return visible;",
    "non-generic host errors should keep existing user-visible semantics",
  );
  assertOrdered(
    app,
    "if (isInternalRuntimeErrorText(text)) return userVisibleRuntimeErrorText(text, fallback);",
    "if (visible && !genericExitOnly) return visible;",
    "internal runtime errors must be mapped before any raw visible-line fallback",
  );

  assertIncludes(
    app,
    "result.response_task?.host_diagnostics ?? result.state?.response_task?.host_diagnostics",
    "poll response_failed path should pass response_task diagnostics",
  );
  assertIncludes(
    app,
    "task?.host_diagnostics ?? result.response_task?.host_diagnostics",
    "canonical delivery response_failed path should pass response_task diagnostics",
  );
  assertIncludes(
    app,
    "userVisibleHostFailureText(result.error, resultTask?.host_diagnostics)",
    "sendMessage failure path should pass response_task diagnostics",
  );

  assert(
    !/userVisibleHostCliFailureText\(message\?: string \| null\)\s*\{/.test(app),
    "host failure formatter should accept diagnostics, not only a raw message",
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-ui-host-failure-diagnostics-verifier-v1",
    checked: [
      "typed_host_diagnostics_bridge",
      "valid_utf8_data_update_labels",
      "generic_exit_prefers_sanitized_provider_reason",
      "non_generic_host_error_keeps_existing_semantics",
      "credentials_commands_paths_and_stacks_are_filtered",
      "host_response_validator_errors_use_product_copy",
      "host_identity_errors_are_not_mislabeled_as_rule_conflicts",
      "lineup_soft_failure_does_not_request_provider_retry",
      "poll_delivery_and_send_paths_forward_diagnostics",
    ],
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
