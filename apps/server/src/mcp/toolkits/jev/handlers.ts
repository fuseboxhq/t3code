import * as Effect from "effect/Effect";
import { JevError, type JevEvaluationInput } from "@t3tools/contracts";
import { Jev } from "../../../jev/Jev.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { JevToolkit } from "./tools.ts";

/** A valid T3 credential alone never grants access to the user's TypeSafe quota. */
export const evaluate = Effect.fn("JevToolkit.evaluate")(function* (input: JevEvaluationInput) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("jev")) {
    return yield* new JevError({
      message: "Jev is unavailable in this session. Enable Jev mode and start a new agent session.",
    });
  }
  return yield* (yield* Jev).evaluate(input);
});

export const JevToolkitHandlersLive = JevToolkit.toLayer({ typesafe_evaluate: evaluate });
