import { z } from "zod";
import { CancelledCompletionError, UnrecoverableRemoteError } from "./errors";

const RoleZodSchema = z.enum(["system", "user", "assistant", "function"]);

type Role = z.infer<typeof RoleZodSchema>;

const MessageZodSchema = z
  .object({
    content: z.string(),
    role: RoleZodSchema,
    name: z.string().optional(),
    function_call: z
      .object({
        name: z.string(),
        arguments: z.string(),
      })
      .optional(),
  })
  .strict();

export type Message = z.infer<typeof MessageZodSchema>;

const ResponseChunkZodSchema = z
  .object({
    id: z.string(),
    object: z.literal("chat.completion.chunk"),
    created: z.number(),
    model: z.string(),
    choices: z.array(
      z.object({
        index: z.number(),
        finish_reason: z.string().nullable(),
        delta: z.union([
          z.object({
            content: z.null().optional(),
            role: RoleZodSchema.optional(),
            function_call: z.object({
              name: z.string().optional(),
              arguments: z.string(),
            }),
          }),
          z.object({
            content: z.string(),
          }),
          z.object({
            role: RoleZodSchema,
          }),
          z.object({}),
        ]),
      })
    ),
  })
  .strict();

/**
 * @property apiKey - OpenAI API key.
 * @property frequencyPenalty - Number between -2.0 and 2.0. Positive values penalize new
 *    tokens based on their existing frequency in the text so far, decreasing the model's
 *    likelihood to repeat the same line verbatim.
 * @property logitBias - Number between -2.0 and 2.0. Positive values penalize new tokens
 *    based on their existing frequency in the text so far, decreasing the model's likelihood to
 *    repeat the same line verbatim.
 * @property maxTokens – The maximum number of tokens to generate in the chat completion.
 *    The total length of input tokens and generated tokens is limited by the model's context length.
 * @property model - ID of the model to use. See the model endpoint compatibility table for
 *    details on which models work with the Chat API.
 * @property presencePenalty - Number between -2.0 and 2.0. Positive values penalize new
 *    tokens based on whether they appear in the text so far, increasing the model's
 *    likelihood to talk about new topics.
 * @property stop - Up to 4 sequences where the API will stop generating further tokens.
 * @property temperature - What sampling temperature to use, between 0 and 2. Higher values
 *    like 0.8 will make the output more random, while lower values like 0.2 will make it
 *    more focused and deterministic.
 *    We generally recommend altering this or top_p but not both.
 * @property topP - An alternative to sampling with temperature, called nucleus sampling,
 *    where the model considers the results of the tokens with top_p probability mass.
 *    So 0.1 means only the tokens comprising the top 10% probability mass are considered.
 *    We generally recommend altering this or temperature but not both.
 * @property user - A unique identifier representing your end-user, which can help OpenAI
 *    to monitor and detect abuse.
 * @property functionCall - Whether or not the model is allowed to call a function.
 * @property functions - Specifications for functions which the model can call.
 */
const CompletionsOptionsZodSchema = z
  .object({
    apiUrl: z.string().optional(),
    onMessage: z
      .function()
      .args(
        z.object({
          cancel: z.function().returns(z.void()),
          message: ResponseChunkZodSchema,
        })
      )
      .returns(z.void())
      .optional(),
    apiKey: z.string(),
    model: z.string(),
    messages: z.array(MessageZodSchema),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    n: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    frequencyPenalty: z.number().optional(),
    presencePenalty: z.number().optional(),
    logitBias: z.record(z.number()).optional(),
    maxTokens: z.number().optional(),
    user: z.string().optional(),
    functionCall: z.enum(["auto", "none"]).optional(),
    functions: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          // TODO This takes a json schema, so we should validate we have a valid json schema
          parameters: z.any().optional(),
        })
      )
      .optional(),
  })
  .strict();

export type CompletionsOptions = z.infer<typeof CompletionsOptionsZodSchema>;

const ChoiceZodSchema = z
  .object({
    role: RoleZodSchema,
    content: z.string(),
    finishReason: z.string(),
    function_call: z
      .object({
        name: z.string(),
        arguments: z.string(),
      })
      .optional(),
  })
  .strict();

export type Choice = z.infer<typeof ChoiceZodSchema>;

const CompletionResponseZodSchema = z.object({
  choices: z.array(ChoiceZodSchema),
});

export type CompletionResponse = z.infer<typeof CompletionResponseZodSchema>;

export const createCompletions = async (
  options: CompletionsOptions
): Promise<CompletionResponse> => {
  const response = await fetch(
    options.apiUrl ?? "https://api.openai.com/v1/chat/completions",
    {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: options.messages,
        model: options.model,
        stream: true,
        temperature: options.temperature,
        top_p: options.topP,
        n: options.n,
        stop: options.stop,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        logit_bias: options.logitBias,
        max_tokens: options.maxTokens,
        user: options.user,
        function_call: options.functionCall,
        functions: options.functions,
      }),
      method: "POST",
    }
  );

  if (!response.body) {
    throw new Error("Expected response to have a body");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  const choices: Choice[] = [];

  let cancelled = false;

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    // {
    //   "error": {
    //     "message": "This model's maximum context length is 4097 tokens. However, your messages resulted in 5034 tokens. Please reduce the length of the messages.",
    //     "type": "invalid_request_error",
    //     "param": "messages",
    //     "code": "context_length_exceeded"
    //   }
    // }
    if (value.startsWith("{")) {
      await reader.cancel();

      // As far as I can tell, if the response is an object, then it is an unrecoverable error.
      throw new UnrecoverableRemoteError(value);
    }

    for (const chunk of value
      .split("\n")
      .map((chunk) => chunk.trim())
      .filter(Boolean)) {
      if (done) {
        break;
      }

      if (chunk === "") {
        continue;
      }

      if (chunk === "data: [DONE]") {
        await reader.cancel();

        break;
      }

      if (!chunk.startsWith("data: ")) {
        throw new Error(`Unexpected message: ${chunk}`);
      }

      const responseChunk = ResponseChunkZodSchema.parse(
        JSON.parse(chunk.toString().slice("data: ".length))
      );

      options.onMessage?.({
        cancel: () => {
          cancelled = true;

          reader.cancel();
        },
        message: responseChunk,
      });

      for (const choiceChunk of responseChunk.choices) {
        const index = choiceChunk.index;

        const choice = (choices[index] = choices[index] ?? {});

        if (
          "finish_reason" in choiceChunk &&
          choiceChunk.finish_reason !== null
        ) {
          choice.finishReason = choiceChunk.finish_reason;
        }

        if ("role" in choiceChunk.delta) {
          choice.role = choiceChunk.delta.role as Role;
        }

        if ("content" in choiceChunk.delta) {
          choice.content = choice.content ?? "";
          choice.content += choiceChunk.delta.content;
        }

        if ("function_call" in choiceChunk.delta) {
          choice.function_call = choice.function_call ?? {
            name: "",
            arguments: "",
          };
          choice.function_call.name +=
            choiceChunk.delta.function_call.name ?? "";
          choice.function_call.arguments +=
            choiceChunk.delta.function_call.arguments ?? "";
        }
      }
    }
  }

  if (cancelled) {
    throw new CancelledCompletionError(choices);
  }

  // When replying to after a function return, the role is not set, so we need to set it ourselves.
  // I suspect that this is an oversight by the api since it requires the role be set in
  // the subsequent calls to the endpoint for the response message from the function.
  for (const choice of choices) {
    if (choice.role === undefined) {
      choice.role = "assistant";
    }
  }

  return {
    choices: ChoiceZodSchema.array().parse(choices),
  };
};
