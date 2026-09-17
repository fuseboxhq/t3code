import { Tool, Toolkit } from "effect/unstable/ai";
import { JevError, JevEvaluationInput, JevEvaluationResult } from "@t3tools/contracts";
import { Jev } from "../../../jev/Jev.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const JevEvaluateTool = Tool.make("typesafe_evaluate", {
  description:
    "Ask Jev for typed judgments over supplied state. Use choice to select a candidate, score to rate ordered criteria, or noul for a yes/no probability. Batch independent questions together (up to 32, 128 KiB total). Supply relevant evidence and narrow questions. This sends the supplied context to TypeSafe and consumes the user's API quota. Results include token usage. Probabilities are judgments, not proof or authorization. Available when Jev mode is enabled; start a new agent session after enabling it.",
  parameters: JevEvaluationInput,
  success: JevEvaluationResult,
  failure: JevError,
  dependencies: [McpInvocationContext, Jev],
})
  .annotate(Tool.Title, "Evaluate with Jev")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const JevToolkit = Toolkit.make(JevEvaluateTool);
