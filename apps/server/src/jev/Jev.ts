import {
  JEV_API_KEY_REDACTED,
  JevError,
  JevEvaluationInput,
  JevEvaluationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";

export class Jev extends Context.Service<
  Jev,
  {
    readonly evaluate: (
      input: JevEvaluationInput,
    ) => Effect.Effect<typeof JevEvaluationResult.Type, JevError>;
  }
>()("t3/jev/Jev") {}

const encodeRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...JevEvaluationInput.fields,
      model: Schema.String,
    }),
  ),
);
const decodeResponse = HttpClientResponse.schemaBodyJson(JevEvaluationResult);

/** Map status codes without exposing upstream bodies or credentials. */
function responseError(status: number): JevError {
  switch (status) {
    case 401:
    case 403:
      return new JevError({
        message: "TypeSafe rejected the API key. Replace it in Settings > Providers.",
      });
    case 429:
    case 529:
      return new JevError({ message: "TypeSafe is busy or rate limited. Try again later." });
    case 422:
      return new JevError({
        message: "TypeSafe rejected the questions. Check their instructions and criteria.",
      });
    default:
      return new JevError({
        message: "TypeSafe could not complete this evaluation. Try again later.",
      });
  }
}

/** An answer must correspond to its question and choose only supplied candidates. */
function answersMatch(input: JevEvaluationInput, result: typeof JevEvaluationResult.Type): boolean {
  if (Object.keys(result.answers).length !== Object.keys(input.questions).length) return false;
  return Object.entries(input.questions).every(([id, question]) => {
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type) return false;
    return (
      question.type !== "choice" ||
      answer.type !== "choice" ||
      Object.hasOwn(question.criteria, answer.choice)
    );
  });
}

/** Calls TypeSafe from the environment, rechecking its opt-in before every request. */
export const layer = Layer.effect(
  Jev,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const client = yield* HttpClient.HttpClient;
    const permits = yield* Semaphore.make(2);
    const evaluate = Effect.fn("Jev.evaluate")(function* (input: JevEvaluationInput) {
      const config = (yield* settings.getSettings.pipe(
        Effect.mapError(() => new JevError({ message: "Could not read Jev settings." })),
      )).jev;
      if (!config.enabled)
        return yield* new JevError({ message: "Jev mode is disabled in Settings > Providers." });
      if (!config.apiKey || config.apiKey === JEV_API_KEY_REDACTED) {
        return yield* new JevError({
          message: "Add your TypeSafe API key in Settings > Providers.",
        });
      }
      const body = yield* encodeRequest({ ...input, model: "jev-latest" }).pipe(
        Effect.mapError(() => new JevError({ message: "Invalid Jev questions or state." })),
      );
      if (Buffer.byteLength(body, "utf8") > 128 * 1024) {
        return yield* new JevError({
          message: "Jev requests must be at most 128 KiB. Send less context.",
        });
      }
      const response = yield* client
        .post("https://api.typesafe.ai/v1/systemone", {
          headers: { authorization: `Bearer ${config.apiKey}` },
          body: HttpBody.text(body, "application/json"),
        })
        .pipe(
          Effect.mapError(
            () => new JevError({ message: "Could not reach TypeSafe. Try again later." }),
          ),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* responseError(response.status);
      }
      const result = yield* decodeResponse(response).pipe(
        Effect.mapError(
          () => new JevError({ message: "TypeSafe returned an invalid evaluation." }),
        ),
      );
      if (!answersMatch(input, result)) {
        return yield* new JevError({
          message: "TypeSafe returned answers that do not match the questions.",
        });
      }
      return result;
    });
    return Jev.of({
      evaluate: (input) =>
        permits
          .withPermits(1)(evaluate(input))
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new JevError({ message: "Jev evaluation timed out. Try again with less context." }),
              ),
            ),
          ),
    });
  }),
);
