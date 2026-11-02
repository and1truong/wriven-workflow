# Client-side tool calling: wire shapes for Anthropic / Gemini / OpenRouter

Research date: 2026-11-03. All claims carry a source URL read on that date unless marked **unverified**.
Context: macOS Swift chat app, current provider interface `reply(messages:[role,content:String]) -> String`, no tool loop yet.

---

## A. Anthropic Messages API (`POST https://api.anthropic.com/v1/messages`)

Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. No beta header needed for custom tools, strict tools, streaming, or `code_execution_2026*`.

### Minimal request
```json
{ "model": "claude-opus-5-5", "max_tokens": 16000,
  "tools": [{ "name": "list_components",
              "description": "List pipeline components available in the workspace. Use before validate_pipeline ...",
              "input_schema": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["source","sink","transform"] } }, "required": [] } }],
  "tool_choice": { "type": "auto", "disable_parallel_tool_use": false },
  "messages": [{ "role": "user", "content": "Which sinks do I have?" }] }
```
Tool definition fields (API ref, https://platform.claude.com/docs/en/api/messages, 2026-11-03): `name` (`^[a-zA-Z0-9_-]{1,128}$`), `description` (optional string, no documented max length; "as detailed as possible"), `input_schema` (JSON Schema 2020-12, root `type:"object"`), optional `strict`, `eager_input_streaming`, `cache_control`, `defer_loading`, `allowed_callers`, `input_examples`, `type:"custom"`.

### Minimal response
```json
{ "id": "msg_01...", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
  "stop_reason": "tool_use", "stop_sequence": null,
  "content": [
    { "type": "text", "text": "I'll list the sinks." },
    { "type": "tool_use", "id": "toolu_01A09q90qw90lq917835lq9", "name": "list_components", "input": { "kind": "sink" } } ],
  "usage": { "input_tokens": 472, "output_tokens": 89, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 } }
```
`tool_use.id` pattern `^[a-zA-Z0-9_-]+$`; `input` is always an object (parse as JSON, never string-match). Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls (2026-11-03).

`stop_reason` enum: `end_turn | max_tokens | stop_sequence | tool_use | pause_turn | refusal | model_context_window_exceeded` (API ref, 2026-11-03). Check `refusal` (Claude 5 family safety classifiers) and `max_tokens` before running tools.

### Minimal follow-up request
```json
{ "model": "claude-opus-5-5", "max_tokens": 16000, "tools": [ ...same tools array... ],
  "messages": [
    { "role": "user", "content": "Which sinks do I have?" },
    { "role": "assistant", "content": [ ...the full response.content array, unchanged... ] },
    { "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
          "content": "[{\"id\":\"s3_sink\",\"name\":\"S3\"}]", "is_error": false } ] } ] }
```
Rules (handle-tool-calls + https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use, 2026-11-03):
- `tool_result` must be in the *next* user message, `tool_result` blocks FIRST, any text after; nothing between the assistant tool_use turn and the results turn.
- All results for parallel `tool_use` blocks go in ONE user message (splitting them teaches the model to stop parallelizing).
- `content` is optional: string, or array of `text | image | document | search_result` blocks; empty result allowed. `is_error: true` for failures; write instructive error text.
- Replay `response.content` verbatim (including `thinking` blocks on Claude 5 models – they are bound to the model/conversation; editing earlier turns can 400 on new accounts, per claude-api skill `shared/model-migration.md`, **unverified against live docs today**).

### tool_choice
`{type:"auto", disable_parallel_tool_use?}` (default), `{type:"any"}`, `{type:"tool", name}`, `{type:"none"}`. **`any`/`tool` return 400 on Claude Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1** – use `auto` + prompt + `strict:true`. `disable_parallel_tool_use:true` with `auto` = at most one call. Changing `tool_choice` invalidates the messages prompt-cache. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools (2026-11-03).

### Streaming (`"stream": true`, SSE)
Events: `message_start` → per block `content_block_start` / `content_block_delta`* / `content_block_stop` → `message_delta` → `message_stop`; also `ping`, `error`.
```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01T1x1fJ34qAmk2tNTrN7Up6","name":"get_weather","input":{}}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}
event: content_block_stop
data: {"type":"content_block_stop","index":1}
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}
```
Concatenate `partial_json` per `index`, parse at `content_block_stop` (first delta may be `""`). `message_delta.usage` is cumulative. Optional `eager_input_streaming:true` per tool streams args without server buffering (then validate the parsed input yourself). Source: https://platform.claude.com/docs/en/build-with-claude/streaming (2026-11-03).

### usage fields (API ref, 2026-11-03)
`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `server_tool_use{web_search_requests, web_fetch_requests}`, `service_tier`, `speed`, `inference_geo`, `output_tokens_details{thinking_tokens}`. Total input = input + cache_creation + cache_read. Tool use also adds a hidden system prompt (~286 tokens on Opus 5.5/Sonnet 5.5/Haiku 5.5; https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview, 2026-11-03).

### Models (https://platform.claude.com/docs/en/models/overview, 2026-11-03)
Current: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (all 1M context, 128K output, dateless IDs are pinned snapshots). Legacy still served: `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8/4-7/4-6/4-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Models API (`GET /v1/models`) returns `max_input_tokens`, `max_tokens`, `capabilities`.

### SDK tool runner
Beta; exists in Python (`@beta_tool` + `client.beta.messages.tool_runner`), TypeScript (`betaZodTool`/`betaTool` + `toolRunner`), C#, Go, Java, PHP, Ruby. **No Swift SDK** – Swift must implement the loop manually over raw HTTP. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner (2026-11-03).

### code_execution + client tools in one request
Yes. `{"type":"code_execution_20260521","name":"code_execution"}` can sit in `tools` beside custom tools; no beta header. If Claude calls a client tool and code_execution in the same turn, the response contains the `server_tool_use` block *without* its result; you reply with ONLY `tool_result` blocks (no text) and the server runs it in the next response. Caveat: "multicomputer" confusion when your client tools also run code. Programmatic tool calling: add `allowed_callers:["code_execution_20260521"]` on the custom tool. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool (2026-11-03).

### Limits
- Request body ≤ 32 MB (413 `request_too_large`): https://platform.claude.com/docs/en/api/overview (2026-11-03, via search snippet).
- Tool name ≤128 chars; no documented description length cap; no documented max tool count for non-strict tools. Strict tools: ≤20 strict tools/request, ≤24 optional params across strict schemas, ≤16 union-typed params (https://platform.claude.com/docs/en/build-with-claude/structured-outputs, 2026-11-03).
- Tool result size: no hard per-block limit documented beyond the 32 MB request cap; it all counts as input tokens. Docs advise "return only high-signal information" (define-tools). 100 KB JSON ≈ 25–35K tokens – allowed, but truncate/summarize for cost.
- Strict/structured JSON-Schema subset: supported `enum`, `const`, `anyOf`, `allOf` (not with `$ref`), local `$ref/$defs/definitions`, `default`, `required`, `additionalProperties:false` (mandatory), formats `date-time,time,date,duration,email,hostname,uri,ipv4,ipv6,uuid`, `minItems` 0|1, simple `pattern`. NOT: recursion, external `$ref`, `minimum/maximum/multipleOf`, `minLength/maxLength`, other array constraints, `additionalProperties` ≠ false. Non-strict tools accept any JSON Schema (model-guided only).

---

## B. Gemini Developer API (`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`)

Auth: header `x-goog-api-key: $KEY` (or `?key=`). Streaming: `:streamGenerateContent?alt=sse`.
Note: Google's docs site (ai.google.dev → aistudio.google.com, redirected 2026-11-03) now leads with the new **Interactions API** (`/v1beta/interactions`, flat `type:"function"` tools, `function_call`/`function_result` steps, lowercase `tool_choice: auto|any|none|validated`). The classic generateContent shapes below are from the REST reference and the official REST cookbook.

### Minimal request
```json
{ "contents": [{ "role": "user", "parts": [{ "text": "Which sinks do I have?" }] }],
  "tools": [{ "functionDeclarations": [{
      "name": "list_components",
      "description": "List pipeline components available in the workspace ...",
      "parameters": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["source","sink","transform"] } } } }] }],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } } }
```
Sources: https://aistudio.google.com/api-reference/caching (Tool/FunctionDeclaration/Schema/FunctionCallingConfig, 2026-11-03); https://github.com/google-gemini/cookbook/blob/main/quickstarts/rest/Function_calling_REST.ipynb (raw fetched 2026-11-03). Both `functionDeclarations` and snake_case `function_declarations` are accepted (cookbook uses both). `parameters` is an OpenAPI-3.0.3-subset `Schema` (type names may be `"object"` or `"OBJECT"`); alternative `parametersJsonSchema` takes real JSON Schema (mutually exclusive with `parameters`).

### Minimal response
```json
{ "candidates": [{ "content": { "role": "model", "parts": [
      { "functionCall": { "name": "list_components", "args": { "kind": "sink" } },
        "thoughtSignature": "<opaque base64>" } ] },
    "finishReason": "STOP", "index": 0 }],
  "usageMetadata": { "promptTokenCount": 120, "candidatesTokenCount": 15, "thoughtsTokenCount": 40, "totalTokenCount": 175 },
  "modelVersion": "gemini-3.8-flash", "responseId": "..." }
```
`FunctionCall{name, args, id?}` – `id` is optional and often absent (REST ref, 2026-11-03); `args` is already a JSON object. `finishReason` values include `STOP, MAX_TOKENS, SAFETY, MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL, TOO_MANY_TOOL_CALLS, MISSING_THOUGHT_SIGNATURE, ...` (https://aistudio.google.com/api-reference/generate-content, 2026-11-03). There is no "tool_calls" finish reason – detect tool calls by scanning `parts[].functionCall`.

### Minimal follow-up request
```json
{ "contents": [
    { "role": "user",  "parts": [{ "text": "Which sinks do I have?" }] },
    { "role": "model", "parts": [{ "functionCall": { "name": "list_components", "args": { "kind": "sink" } }, "thoughtSignature": "<same value>" }] },
    { "role": "user",  "parts": [{ "functionResponse": { "name": "list_components",
          "response": { "result": [{ "id": "s3_sink", "name": "S3" }] } } }] } ],
  "tools": [ ...same... ] }
```
- `FunctionResponse{name (req), response (req, JSON object – wrap non-objects, use `"error"` key on failure), id?, parts?, willContinue?, scheduling?}`.
- Role for the results turn: REST ref says `Content.role` "Must be either 'user' or 'model'" (2026-11-03); the older cookbook uses `"role": "function"`. Use `"user"` (SDK behavior) – **`"function"` legacy, unverified on current models**.
- Thought signatures (Gemini 3+): return `thoughtSignature` in the exact same part it arrived in; parallel calls carry it only on the first `functionCall` part; omitting it on the first call of a step → 400 (`MISSING_THOUGHT_SIGNATURE`); keep all functionCalls then all functionResponses in matching order; text-only signatures optional; last-resort dummy `"skip_thought_signature_validator"`. Source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures (Vertex doc, 2026-11-03; Developer-API page now covers Interactions only – semantics assumed identical, **partly unverified**).

### toolConfig.functionCallingConfig (REST ref, 2026-11-03)
`mode`: `AUTO` (default) | `ANY` (must call) | `NONE` | `VALIDATED` (like AUTO but constrained-decoded args). `allowedFunctionNames: [..]` only with `ANY`/`VALIDATED`. Parallel calls: multiple `functionCall` parts in one `content.parts`; return one `functionResponse` part per call in one user turn. Interactions-API doc notes "`any` mode may reject very large or deeply nested schemas" and recommends ≤10–20 active tools (https://aistudio.google.com/docs/function-calling, 2026-11-03).

### Streaming
`POST .../models/{m}:streamGenerateContent?alt=sse` → `data: {GenerateContentResponse}` lines; without `alt=sse` you get a JSON array instead. Each chunk is a full `GenerateContentResponse`; `functionCall` parts arrive whole in one chunk (no partial-JSON args – **behavioural, unverified in docs**); a `thoughtSignature` may arrive in a part with empty text, so read all parts until `finishReason`. `usageMetadata` appears on chunks and is cumulative (last chunk authoritative). Sources: cookbook Streaming_REST.ipynb (2026-11-03); Vertex thought-signatures doc.

### usageMetadata fields (generate-content REST ref, 2026-11-03)
`promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `toolUsePromptTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, `promptTokensDetails[]`, `cacheTokensDetails[]`, `candidatesTokensDetails[]`, `toolUsePromptTokensDetails[]`.

### Models (https://aistudio.google.com/docs/models, 2026-11-03)
`gemini-4-argon` (1M ctx), `gemini-3.8-flash` (new; used in docs examples), `gemini-3.6-flash` (stable), `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`. `gemini-2.5-pro/flash` deprecated (auto-reroute 2026-12-01). Per-model function-calling support not stated on that page (all Gemini 3+ text models support it – **unverified**).

### Limits & schema subset
- Function name: `[a-zA-Z0-9_:.-]`, max 128 (REST ref). Description required. No documented description length cap.
- `parameters` Schema keywords: `type, format, title, description, nullable, enum, items, minItems, maxItems, properties, required, minProperties, maxProperties, minimum, maximum, minLength, maxLength, pattern, anyOf, propertyOrdering, default, example`. NOT in the Schema object: `$ref/$defs`, `oneOf`, `allOf`, `additionalProperties`, `const`. Use `parametersJsonSchema` for `$ref`-style schemas (JSON-Schema mode supports `$ref:"#"`, `anyOf`, `additionalProperties`, type arrays for null; ignores `minLength/maxLength`, `minProperties/maxProperties`, `uniqueItems`; very large/nested schemas → 400 INVALID_ARGUMENT) – https://aistudio.google.com/docs/structured-output (2026-11-03).
- Request size: Google raised inline payload limit 20 MB → 100 MB (blog.google announcement via search, 2026-11-03, **unverified exact current value**); `functionResponse` is plain JSON in the request, so 100 KB is fine size-wise but counts as prompt tokens.

---

## C. OpenRouter Chat Completions (`POST https://openrouter.ai/api/v1/chat/completions`)

Headers: `Authorization: Bearer $KEY`, optional `HTTP-Referer`, `X-Title`.

### Minimal request
```json
{ "model": "anthropic/claude-opus-5.5",
  "messages": [{ "role": "user", "content": "Which sinks do I have?" }],
  "tools": [{ "type": "function", "function": {
      "name": "list_components", "description": "List pipeline components ...",
      "parameters": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["source","sink","transform"] } } } } }],
  "tool_choice": "auto", "parallel_tool_calls": true, "stream": false }
```
`tool_choice`: `"none" | "auto" | "required" | {"type":"function","function":{"name":"..."}}`; `parallel_tool_calls` boolean, default true (https://openrouter.ai/docs/api/reference/parameters, 2026-11-03). `tools` must be sent on every request of the loop (https://openrouter.ai/docs/guides/features/tool-calling, 2026-11-03). Function name limit noted in OpenAPI: 64 chars `[A-Za-z0-9_-]` (https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion, 2026-11-03) – stricter than Anthropic's 128.

### Minimal response
```json
{ "id": "gen-...", "object": "chat.completion", "model": "anthropic/claude-opus-5.5",
  "choices": [{ "index": 0, "finish_reason": "tool_calls", "native_finish_reason": "tool_use",
    "message": { "role": "assistant", "content": null,
      "tool_calls": [{ "id": "call_abc123", "type": "function",
        "function": { "name": "list_components", "arguments": "{\"kind\":\"sink\"}" } }] } }],
  "usage": { "prompt_tokens": 120, "completion_tokens": 20, "total_tokens": 140, "cost": 0.00042,
             "prompt_tokens_details": { "cached_tokens": 0 }, "completion_tokens_details": { "reasoning_tokens": 0 } } }
```
`function.arguments` is a JSON **string** – parse it. `finish_reason` normalized to `tool_calls | stop | length | content_filter | error` (+`native_finish_reason` raw). Sources: OpenAPI page + https://openrouter.ai/docs/api/reference/overview (2026-11-03).

### Minimal follow-up request
```json
{ "model": "anthropic/claude-opus-5.5", "tools": [ ...same... ],
  "messages": [
    { "role": "user", "content": "Which sinks do I have?" },
    { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_abc123", "type": "function", "function": { "name": "list_components", "arguments": "{\"kind\":\"sink\"}" } }] },
    { "role": "tool", "tool_call_id": "call_abc123", "content": "[{\"id\":\"s3_sink\",\"name\":\"S3\"}]" } ] }
```
`ChatToolMessage{role:"tool", tool_call_id, content: string | content-items[]}` all required. One tool message per call, in order. For reasoning models, echo back the assistant message *including* any `reasoning`/`reasoning_details` fields ("required context for some providers") – tool-calling guide, 2026-11-03.

### Streaming (`"stream": true`)
SSE `data: {chunk}` lines; ignore comment lines starting with `:` (e.g. `: OPENROUTER PROCESSING`); ends with `data: [DONE]`. Tool-call deltas: `choices[0].delta.tool_calls[]` items are `ChatStreamToolCall{index (int, required), id?, type:"function"?, function:{name?, arguments?}}` – accumulate `arguments` fragments keyed by `index`; `id`/`name` arrive on the first fragment. Don't execute until stream ends. `finish_reason:"tool_calls"` appears on the last content chunk AND again on a final usage-only chunk (`choices[0].delta` empty) just before `[DONE]`. Mid-stream errors: HTTP stays 200, chunk carries top-level `error` + `finish_reason:"error"`. Sources: OpenAPI page (ChatStreamToolCall), https://openrouter.ai/docs/api/reference/streaming (2026-11-03).

### usage
Always included (non-stream: in body; stream: final chunk). `usage:{include:true}` and `stream_options.include_usage` are **deprecated no-ops** (https://openrouter.ai/docs/guides/guides/usage-accounting, 2026-11-03). Fields: `prompt_tokens, completion_tokens, total_tokens, cost, is_byok, prompt_tokens_details{cached_tokens, cache_write_tokens, audio_tokens, video_tokens}, completion_tokens_details{reasoning_tokens, ...}, cost_details{upstream_inference_cost, ...}, server_tool_use`. Post-hoc: `GET /api/v1/generation?id=`.

### Model capability
`GET https://openrouter.ai/api/v1/models` (public, no key) → `data[].supported_parameters` (observed 2026-11-03: values include `tools`, `tool_choice`, `parallel_tool_calls`, `structured_outputs`, `response_format`, `reasoning`, ...). Filter: `?supported_parameters=tools`. Live count 2026-11-03: 451 models, 363 list `tools`, 64 do not. A model with no tool-capable endpoint → 404 "no endpoints support tool use"; in fallback routing a non-tool model may silently ignore `tools` (blog, 2026-11-03). Gate the agent surface on `"tools" ∈ supported_parameters`.

### Limits
No documented tool count / description length / result size; 413 on oversized payloads (no number). Upstream provider limits apply (Anthropic 32 MB, etc.). OpenRouter's agent-loop blog recommends truncating big results as *valid JSON* with `{preview, original_size, truncated:true}` rather than slicing strings (https://openrouter.ai/blog/tutorials/build-tool-calling-agent-loop/, 2026-11-03).

---

## Common denominator (provider-neutral tool definition)

**Name**: `^[a-zA-Z0-9_-]{1,64}$` (OpenRouter's 64 is the tightest; Anthropic 128, Gemini 128). Prefix by domain (`pipeline_validate`, `stream_pause`) per Anthropic guidance.

**Description**: plain text, 3–4+ sentences, no documented cap anywhere; keep ≤ ~1–2 KB per tool for token cost.

**Schema** – write *one* JSON-Schema-ish object per tool and only use this intersection:
- Root `type:"object"`, `properties`, `required`, per-property `type`, `description`, `enum` (strings only), `items`, nested objects (shallow, ≤3 levels).
- Types: `string, number, integer, boolean, array, object`. For nullable use Gemini's `nullable:true` only if you emit a Gemini-specific variant; otherwise make the field optional instead of nullable.
- AVOID: `$ref/$defs`, `oneOf/allOf/anyOf`, `const`, `additionalProperties` (Gemini `parameters` Schema has none of these; Anthropic strict *requires* `additionalProperties:false` – add it only in the Anthropic encoder when `strict:true`), `pattern`, `format` (Anthropic strict accepts only a fixed list; Gemini accepts a few; OpenAI-compat models vary), `minimum/maximum/minLength/maxLength/multipleOf` (Anthropic strict 400s; Gemini JSON mode ignores length), `minItems>1`, recursion, `default`.
- Encoders: Anthropic → `{name, description, input_schema: schema[, strict:true + additionalProperties:false]}`; Gemini → `{functionDeclarations:[{name, description, parameters: schema}]}` (or `parametersJsonSchema` if you ever need `$ref`); OpenRouter → `{type:"function", function:{name, description, parameters: schema}}`.

**Tool-call id mapping** (the app should keep its own `callId` and store the provider's native id next to it):
| | id on call | id on result | notes |
|---|---|---|---|
| Anthropic | `tool_use.id` (`toolu_…`) | `tool_result.tool_use_id` | required, unique per block |
| Gemini | `functionCall.id` optional (usually absent) | `functionResponse.id` optional; matched by `name` + order | carry `thoughtSignature` on the call part; results in same order as calls |
| OpenRouter | `tool_calls[].id` (`call_…`, provider-specific format) | `role:"tool"` `tool_call_id` | streaming: correlate fragments by `index`, then by `id` |

**Loop termination signal**: Anthropic `stop_reason=="tool_use"`; OpenRouter `finish_reason=="tool_calls"` (or non-empty `tool_calls`); Gemini: any `parts[].functionCall` present (no dedicated finish reason).

**Result payload**: all three accept a plain string (Anthropic/OpenRouter) or a JSON object (Gemini `response` must be an object – wrap as `{"result": ...}`; put failures as `{"error": "..."}`; Anthropic has `is_error:true`; OpenRouter has no flag – put `"error"` in content text). Cap tool results app-side (e.g. ≤ 32 KB, valid-JSON truncation with `truncated:true`) – no provider gives a per-result limit, only whole-request caps (Anthropic 32 MB; Gemini ~100 MB inline, unverified; OpenRouter 413 unspecified).

**Parallel calls**: all three may emit several calls in one turn; return all results in one follow-up turn (Anthropic: one user message, results first; Gemini: one user content, functionResponses in call order; OpenRouter: consecutive `role:"tool"` messages). Turn off via Anthropic `tool_choice.disable_parallel_tool_use`, OpenRouter `parallel_tool_calls:false`; Gemini has no switch.

**Forcing**: do NOT rely on forced tool use – Anthropic 5.5/Fable 5.1 reject `any`/`tool`; OpenRouter `required` support varies by model; Gemini `ANY` exists. Use `auto` + prompt instruction everywhere.

**History replay**: Anthropic needs the full `content` array (incl. thinking blocks) echoed; Gemini needs `thoughtSignature` echoed in-place; OpenRouter needs the assistant `tool_calls` message (plus `reasoning_details` when present) echoed. So the app's message model must store the provider's raw assistant turn, not just text.
