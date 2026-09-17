import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Description = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Json),
  Schema.Array(Schema.Json),
]);
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Probabilities = Schema.Record(Schema.String, Probability);
const Question = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("noul"),
    instructions: Description,
    criteria: Schema.optionalKey(
      Schema.Struct({
        true: Schema.optionalKey(Description),
        false: Schema.optionalKey(Description),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Description,
    criteria: Schema.Record(TrimmedNonEmptyString, Schema.NullOr(Description)).check(
      Schema.isMinProperties(2),
      Schema.isMaxProperties(128),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: Description,
    criteria: Schema.Array(Description).check(Schema.isMinLength(2), Schema.isMaxLength(128)),
  }),
]);

/** Batches independent judgments over the same state, with a fixed request budget. */
export const JevEvaluationInput = Schema.Struct({
  state: Description,
  questions: Schema.Record(TrimmedNonEmptyString, Question).check(
    Schema.isMinProperties(1),
    Schema.isMaxProperties(32),
  ),
});
export type JevEvaluationInput = typeof JevEvaluationInput.Type;

export const JevEvaluationResult = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
      Schema.Struct({
        type: Schema.Literal("choice"),
        choice: Schema.String,
        probabilities: Probabilities,
        confidence: Probability,
      }),
      Schema.Struct({
        type: Schema.Literal("score"),
        score: Schema.Number,
        legend: Schema.Record(Schema.String, Description),
        probabilities: Probabilities,
        confidence: Probability,
      }),
    ]),
  ),
  usage: Schema.Struct({ input_tokens: NonNegativeInt, output_tokens: NonNegativeInt }),
});

/** Public errors deliberately exclude request bodies, headers, and upstream error text. */
export class JevError extends Schema.TaggedErrorClass<JevError>()("JevError", {
  message: Schema.String,
}) {}
