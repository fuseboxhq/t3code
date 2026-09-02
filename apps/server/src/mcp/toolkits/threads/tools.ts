import {
  AgentThreadError,
  AgentThreadInterruptResult,
  AgentThreadListInput,
  AgentThreadListResult,
  AgentThreadResult,
  AgentThreadSendInput,
  AgentThreadSendResult,
  AgentThreadSpawnInput,
  AgentThreadSpawnResult,
  AgentThreadTargetInput,
  AgentThreadWaitInput,
  AgentThreadWaitResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBootstrap from "../../../orchestration/ThreadBootstrap.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Crypto.Crypto,
  ThreadBootstrap.ThreadBootstrap,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  ProviderRegistry,
  ServerSettingsService,
  GitWorkflowService.GitWorkflowService,
];

export const ThreadSpawnTool = Tool.make("thread_spawn", {
  description:
    "Start a sub-thread in your project and send it a first message. The sub-thread is a real T3 Code thread, nested under yours in the sidebar, running on its own provider session. Returns immediately; use thread_wait to block until it finishes and thread_result to read its answer. Give it everything it needs in the prompt: it cannot see your conversation.",
  parameters: AgentThreadSpawnInput,
  success: AgentThreadSpawnResult,
  failure: AgentThreadError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn sub-thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadWaitTool = Tool.make("thread_wait", {
  description:
    "Block until sub-threads you spawned finish their current turn (or fail), or until timeoutMs elapses. Returns each thread's state; timedOut=true means at least one is still working and you should call thread_wait again.",
  parameters: AgentThreadWaitInput,
  success: AgentThreadWaitResult,
  failure: AgentThreadError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for sub-threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadResultTool = Tool.make("thread_result", {
  description:
    "Read a sub-thread's latest completed assistant message along with its state. Call after thread_wait reports it idle.",
  parameters: AgentThreadTargetInput,
  success: AgentThreadResult,
  failure: AgentThreadError,
  dependencies,
})
  .annotate(Tool.Title, "Read sub-thread result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadSendTool = Tool.make("thread_send", {
  description:
    "Send a follow-up message to a sub-thread you spawned, keeping its context. Use it to answer questions, request fixes, or hand over the next task. Sending while it is running steers the current turn.",
  parameters: AgentThreadSendInput,
  success: AgentThreadSendResult,
  failure: AgentThreadError,
  dependencies,
})
  .annotate(Tool.Title, "Message sub-thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadListTool = Tool.make("thread_list", {
  description: "List the sub-threads you spawned in this thread, with their current state.",
  parameters: AgentThreadListInput,
  success: AgentThreadListResult,
  failure: AgentThreadError,
  dependencies,
})
  .annotate(Tool.Title, "List sub-threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadInterruptTool = Tool.make("thread_interrupt", {
  description:
    "Interrupt a sub-thread's current turn. The thread stays in the sidebar and can be resumed with thread_send.",
  parameters: AgentThreadTargetInput,
  success: AgentThreadInterruptResult,
  failure: AgentThreadError,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt sub-thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadToolkit = Toolkit.make(
  ThreadSpawnTool,
  ThreadWaitTool,
  ThreadResultTool,
  ThreadSendTool,
  ThreadListTool,
  ThreadInterruptTool,
);
