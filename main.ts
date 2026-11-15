// Aggregator for free-model-aggregator-02: one server, two client wires, fourteen
// free OpenRouter models behind it, dialled through the grader's gateway.
//
// The server reads the trial brief (the free model list with the house's
// ratings, and the six prompts in arrival order), picks the best-rated free
// model that can meet each prompt, and answers it on the wire the client
// used. Every completion comes from a real model call; this file never
// invents an answer. Routing, failover and every reply are pure functions
// of the brief, the request bodies and the gateway's answers, so a replay
// of the trial reproduces the same requests and the same state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

// ---------------------------------------------------------------------------
// Trial environment
// ---------------------------------------------------------------------------

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const BRIEF_PATH = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const PROTOCOL_VERSION = 1;
const POLL_MS = 100;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const DIAL_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS_PER_PROMPT = 4;
const MAX_TRAIL_ROWS = 8;
const GATEWAY_MAX_TOKENS = 8192;
const DEFAULT_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// The brief: free model list + prompt manifest
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  provider: string;
  display: string;
  rating: number;
  context: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  needs: Needs;
}

interface Needs {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  minContext?: number;
}

interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  problem: string | null;
}

/** The `{` … matching `}` span starting at `at`, skipping string contents. */
function braceSpan(text: string, at: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every top-level JSON object in `text` that carries a string `schema`. */
function schemaDocs(text: string): Json[] {
  const found: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = braceSpan(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isObj(value) && typeof value.schema === 'string') found.push(value);
    } catch {
      // Not a standalone document; keep scanning.
    }
  }
  return found;
}

/** First document under this competition's schema prefix holding an array under one of `keys`. */
function docWithArray(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  for (const doc of docs) {
    if (!asStr(doc.schema).includes('free-model-aggregator-02/')) continue;
    for (const key of keys) if (Array.isArray(doc[key])) return { doc, key };
  }
  return null;
}

function parseModel(v: unknown): ModelRow | null {
  if (!isObj(v)) return null;
  const raw = asStr(v.id) !== '' ? asStr(v.id) : asStr(v.model);
  if (raw === '') return null;
  const named = asStr(v.provider) !== '' ? asStr(v.provider) : asStr(v.wire);
  const id = named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    display: asStr(v.display_name) !== '' ? asStr(v.display_name) : raw,
    rating: asNum(v.rating_milli) ?? 0,
    context: asNum(v.context_length),
    tools: asBool(v.tools),
    vision: asBool(v.vision),
    json: asBool(v.json),
    free: v.free !== false,
  };
}

function parsePrompt(v: unknown): PromptRow | null {
  if (!isObj(v)) return null;
  const id = asStr(v.id);
  if (id === '') return null;
  const req = isObj(v.requires) ? v.requires : {};
  const needs: Needs = {};
  if (req.tools === true) needs.tools = true;
  if (req.vision === true) needs.vision = true;
  if (req.json === true) needs.json = true;
  if (typeof req.min_context === 'number' && Number.isFinite(req.min_context)) needs.minContext = req.min_context;
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    needs,
  };
}

function loadBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], problem: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], problem: `cannot read brief: ${(err as Error).message}` };
  }
  const docs = schemaDocs(text);
  const modelsDoc = docWithArray(docs, ['models', 'ratings']);
  if (modelsDoc === null) return { models: [], prompts: [], problem: 'brief holds no models document' };
  const models = (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((v) => {
    const m = parseModel(v);
    return m === null ? [] : [m];
  });
  const promptsDoc = docWithArray(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) return { models, prompts: [], problem: 'brief holds no prompts document' };
  const prompts = (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((v) => {
    const p = parsePrompt(v);
    return p === null ? [] : [p];
  });
  return { models, prompts, problem: null };
}

// ---------------------------------------------------------------------------
// The catalog: exactly the brief's free models, byte-identical everywhere
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface Catalog {
  providers: Array<{ id: string; base_url: string; key_env: string; wire: 'openai'; models: CatalogModel[] }>;
}

function buildCatalog(brief: Brief): Catalog {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const m of brief.models) {
    if (!m.free || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({ id: m.id, free: true, context_length: m.context });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        wire: 'openai',
        models,
      },
    ],
  };
}

const brief = loadBrief(BRIEF_PATH);
const catalog: Catalog = buildCatalog(brief);

// ---------------------------------------------------------------------------
// Routing: best-rated free model that meets the prompt, with failover order
// ---------------------------------------------------------------------------

function freeModels(): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

function capable(m: ModelRow, needs: Needs): boolean {
  if (needs.tools === true && m.tools !== true) return false;
  if (needs.vision === true && m.vision !== true) return false;
  if (needs.json === true && m.json !== true) return false;
  if (needs.minContext !== undefined && (m.context === null || m.context < needs.minContext)) return false;
  return true;
}

/**
 * The arrival ordinal of each model's latest refusal. A model that refused
 * on the prompt just before this one sorts behind every model that did not,
 * so one rate-limited model cannot sink the next prompt outright — but it
 * is tried again the prompt after that, because a free-tier 429 is usually
 * a per-minute limit that has already cleared. The map only ever grows
 * from gateway answers, which keeps live and replay on the same routing.
 */
const lastRefused = new Map<string, number>();
function noteRefusal(id: string): void {
  lastRefused.set(id, arrival);
}

/** Whether `id` refused on the prompt immediately before the current one. */
function cooling(id: string): boolean {
  return lastRefused.get(id) === arrival - 1;
}

/**
 * Every free model that can serve `needs`, best first: models not cooling
 * down by rating (ties keep brief order), then cooling models by the same
 * rule. The caller walks this list and dials until one answers.
 */
function rankedCandidates(needs: Needs): ModelRow[] {
  const able = freeModels().filter((m) => capable(m, needs));
  const withIndex = able.map((m, i) => ({ m, i }));
  withIndex.sort((a, b) => {
    const ca = cooling(a.m.id);
    const cb = cooling(b.m.id);
    if (ca !== cb) return ca ? 1 : -1;
    if (a.m.rating !== b.m.rating) return b.m.rating - a.m.rating;
    return a.i - b.i;
  });
  return withIndex.map((x) => x.m);
}

// ---------------------------------------------------------------------------
// Which prompt is arriving: the manifest row by arrival order, else the body
// ---------------------------------------------------------------------------

let arrival = 0;

function needsFromBody(body: Json): Needs {
  const needs: Needs = {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isObj(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isObj(block) && (block.type === 'image' || block.type === 'image_url')) needs.vision = true;
    }
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) needs.tools = true;
  const format = isObj(body.response_format) ? body.response_format.type : undefined;
  if (format === 'json_object' || format === 'json_schema') needs.json = true;
  return needs;
}

function needsFor(body: Json): Needs {
  const row = brief.prompts[arrival];
  arrival += 1;
  if (row !== undefined) return row.needs;
  return needsFromBody(body);
}

// ---------------------------------------------------------------------------
// The two client wires and the one upstream wire (Chat Completions)
// ---------------------------------------------------------------------------

/** Fixed timestamps in the model lists: the replies must not read the clock. */
const LIST_CREATED = 1767225600;
const LIST_CREATED_AT = '2026-01-01T00:00:00Z';

interface ListedModel {
  id: string;
  provider: string;
  display: string;
}

function listModels(): ListedModel[] {
  return freeModels().map((m) => ({ id: m.id, provider: m.provider, display: m.display }));
}

function openAIList(models: readonly ListedModel[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: LIST_CREATED, owned_by: m.provider })),
  };
}

function anthropicList(models: readonly ListedModel[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display, created_at: LIST_CREATED_AT })),
    has_more: false,
  };
}

function openAIError(message: string, type: string): Json {
  return { error: { message, type, code: null } };
}

function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function argsObject(v: unknown): Json {
  if (isObj(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (isObj(parsed)) return parsed;
    } catch {
      // Not JSON: empty input.
    }
  }
  return {};
}

function finishToStop(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** One Anthropic content block as an OpenAI content part, or null when it carries nothing. */
function openAIPart(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isObj(block.source)) {
    const src = block.source;
    if (src.type === 'base64' && typeof src.data === 'string') {
      const media = typeof src.media_type === 'string' ? src.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } };
    }
    if (src.type === 'url' && typeof src.url === 'string') return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/**
 * An Anthropic Messages request rewritten as a Chat Completions request that
 * names `model`: system prompt first, images as data URLs, tool_use as
 * tool_calls, tool_result as tool messages, tools and tool_choice converted,
 * caps and sampling settings carried through.
 */
function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isObj(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const calls: Json[] = [];
      for (const block of content) {
        if (!isObj(block) || block.type !== 'tool_use') continue;
        calls.push({
          id: asStr(block.id),
          type: 'function',
          function: {
            name: asStr(block.name),
            arguments: JSON.stringify(isObj(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({ role: 'assistant', content: text !== '' ? text : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: asStr(block.tool_use_id), content: toolResultText(block.content) });
        continue;
      }
      const part = openAIPart(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isObj(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: asStr(raw.description),
            parameters: isObj(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isObj(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** A Chat Completions answer rewritten as an Anthropic Messages object. */
function openAIToAnthropic(body: Json, model: string): Json {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isObj(choices[0]) ? choices[0] : {};
  const message = isObj(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isObj(call) || !isObj(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: asStr(call.id) !== '' ? asStr(call.id) : 'toolu_unknown',
      name: asStr(call.function.name),
      input: argsObject(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isObj(body.usage) ? body.usage : {};
  return {
    id: `msg_${asStr(body.id) !== '' ? asStr(body.id) : 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: finishToStop(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: numOrZero(usage.prompt_tokens), output_tokens: numOrZero(usage.completion_tokens) },
  };
}

function sseLine(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** One upstream SSE frame with every data payload's `model` set to the dialled id. */
function frameWithModel(frame: string, model: string): string {
  const lines = frame.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    try {
      const chunk: unknown = JSON.parse(payload);
      if (isObj(chunk)) return `data: ${JSON.stringify({ ...chunk, model })}`;
    } catch {
      // Not JSON: relay as it came.
    }
    return line;
  });
  return `${lines.join('\n')}\n\n`;
}

/** Relay an upstream Chat Completions stream, naming the dialled model on every chunk. */
async function* relayOpenAIStream(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        yield frameWithModel(buffer.slice(0, at), model);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') yield frameWithModel(buffer, model);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Translate an upstream Chat Completions stream into the Anthropic event
 * sequence: message_start, one content block per text run or tool call,
 * message_delta with the stop reason and usage, message_stop. The stop
 * reason waits for the stream's final usage chunk before it is reported.
 */
async function* translateAnthropicStream(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let finished = false;
  let pendingStop: string | null = null;
  let textIndex = -1;
  let nextIndex = 0;
  const toolAt = new Map<number, number>();
  let inputTokens = 0;
  let outputTokens = 0;

  const openEvents = (): string[] => {
    if (started) return [];
    started = true;
    return [
      sseLine('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    ];
  };
  const closeBlocks = (): string[] => {
    const out: string[] = [];
    if (textIndex !== -1) {
      out.push(sseLine('content_block_stop', { type: 'content_block_stop', index: textIndex }));
      textIndex = -1;
    }
    for (const index of [...toolAt.values()].sort((a, b) => a - b)) {
      out.push(sseLine('content_block_stop', { type: 'content_block_stop', index }));
    }
    toolAt.clear();
    return out;
  };
  const finishEvents = (stop: string): string[] => {
    if (finished) return [];
    finished = true;
    return [
      ...closeBlocks(),
      sseLine('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } }),
      sseLine('message_stop', { type: 'message_stop' }),
    ];
  };
  const eventsOfFrame = (frame: string): string[] => {
    const out: string[] = [];
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        out.push(...openEvents(), ...finishEvents(pendingStop ?? 'end_turn'));
        continue;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isObj(chunk)) continue;
      if (isObj(chunk.usage)) {
        inputTokens = numOrZero(chunk.usage.prompt_tokens);
        outputTokens = numOrZero(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isObj(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isObj(choice.delta) ? choice.delta : {};
      out.push(...openEvents());
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIndex === -1) {
          textIndex = nextIndex;
          nextIndex += 1;
          out.push(sseLine('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }));
        }
        out.push(sseLine('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } }));
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isObj(call)) continue;
        const upstreamIndex = typeof call.index === 'number' ? call.index : toolAt.size;
        let index = toolAt.get(upstreamIndex);
        if (index === undefined) {
          if (textIndex !== -1) {
            out.push(sseLine('content_block_stop', { type: 'content_block_stop', index: textIndex }));
            textIndex = -1;
          }
          index = nextIndex;
          nextIndex += 1;
          toolAt.set(upstreamIndex, index);
          const fn = isObj(call.function) ? call.function : {};
          out.push(
            sseLine('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: asStr(call.id) !== '' ? asStr(call.id) : `toolu_${index}`,
                name: asStr(fn.name),
                input: {},
              },
            }),
          );
        }
        const fn = isObj(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          out.push(sseLine('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) pendingStop = finishToStop(choice.finish_reason);
    }
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        for (const event of eventsOfFrame(buffer.slice(0, at))) yield event;
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') for (const event of eventsOfFrame(buffer)) yield event;
  } finally {
    reader.releaseLock();
  }
  if (!finished) {
    for (const event of openEvents()) yield event;
    for (const event of finishEvents(pendingStop ?? 'end_turn')) yield event;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown, failures?: TrailRow[]): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
  const trail = trailValue(failures);
  if (trail !== null) headers['x-makefun-upstream-failures'] = trail;
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, failures?: TrailRow[]): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), failures);
  else sendJson(res, status, openAIError(message, type), failures);
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_READ_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dialling the gateway, with failover and the refusal trail
// ---------------------------------------------------------------------------

interface TrailRow {
  status: number;
  code: string;
  model: string | null;
}

function trailValue(rows?: TrailRow[]): string | null {
  if (rows === undefined || rows.length === 0) return null;
  const trimmed = rows.slice(0, MAX_TRAIL_ROWS);
  const text = JSON.stringify(trimmed);
  if (Buffer.byteLength(text) > 8192) return null;
  return text;
}

function gatewayCompletionsUrl(): string {
  if (GATEWAY_BASE === '') return '';
  return GATEWAY_BASE.endsWith('/v1') ? `${GATEWAY_BASE}/chat/completions` : `${GATEWAY_BASE}/v1/chat/completions`;
}

/** The upstream body for a dial: the client's body, the model, and a legal output cap. */
function upstreamBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  const cap = typeof out.max_tokens === 'number' ? out.max_tokens : typeof out.max_completion_tokens === 'number' ? out.max_completion_tokens : undefined;
  if (cap === undefined) out.max_tokens = DEFAULT_MAX_TOKENS;
  else if (cap > GATEWAY_MAX_TOKENS) out.max_tokens = GATEWAY_MAX_TOKENS;
  if (out.stream === true && !isObj(out.stream_options)) out.stream_options = { include_usage: true };
  return out;
}

function failureCode(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObj(parsed) && isObj(parsed.error)) {
      const code = parsed.error.code;
      if (typeof code === 'string' && code !== '') return code;
      const type = parsed.error.type;
      if (typeof type === 'string' && type !== '') return type;
    }
  } catch {
    // Not JSON: fall through to the status-based code.
  }
  return `http_${status}`;
}

type DialOutcome =
  | { served: true; res: Response; model: string; failures: TrailRow[] }
  | { served: false; failures: TrailRow[] };

/**
 * Dial candidates in ranked order until one answers. A refusal is recorded
 * in the trail and the model is cooled down for the prompts after this one;
 * a prompt whose every candidate refuses ends here and the caller answers
 * 502. At most MAX_ATTEMPTS_PER_PROMPT calls are spent on one prompt.
 */
async function dialWithFailover(candidates: ModelRow[], body: Json): Promise<DialOutcome | null> {
  const failures: TrailRow[] = [];
  const tries = candidates.slice(0, MAX_ATTEMPTS_PER_PROMPT);
  for (const candidate of tries) {
    let upstream: Response;
    try {
      upstream = await fetch(gatewayCompletionsUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify(upstreamBody(body, candidate.id)),
        signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      failures.push({ status: timedOut ? 504 : 502, code: timedOut ? 'timeout' : 'upstream_unreachable', model: candidate.id });
      noteRefusal(candidate.id);
      continue;
    }
    if (upstream.ok) return { served: true, res: upstream, model: candidate.id, failures };
    const text = await upstream.text().catch(() => '');
    failures.push({ status: upstream.status, code: failureCode(upstream.status, text), model: candidate.id });
    noteRefusal(candidate.id);
  }
  return { served: false, failures };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function modelsRoute(req: IncomingMessage, res: ServerResponse): void {
  const list = listModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicList(list));
  else sendJson(res, 200, openAIList(list));
}

async function chatRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = rankedCandidates(needsFor(body));
  if (candidates.length === 0) return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  const outcome = await dialWithFailover(candidates, body);
  if (!outcome.served) {
    return sendError(res, 'openai', 502, 'upstream_error', 'every free model that meets this request refused it', outcome.failures);
  }
  const { res: upstream, model, failures } = outcome;
  if (upstream.body === null) return sendError(res, 'openai', 502, 'upstream_error', 'the gateway answered with no body', failures);
  const trail = trailValue(failures);
  if (body.stream === true) {
    const headers: Record<string, string> = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };
    if (trail !== null) headers['x-makefun-upstream-failures'] = trail;
    res.writeHead(200, headers);
    try {
      for await (const frame of relayOpenAIStream(upstream.body, model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json().catch(() => null);
  if (!isObj(answer)) return sendError(res, 'openai', 502, 'upstream_error', 'the gateway answer is not one JSON object', failures);
  sendJson(res, 200, { ...answer, model }, failures);
}

async function messagesRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = rankedCandidates(needsFor(body));
  if (candidates.length === 0) return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  // The prompt's own body shapes the first dial; every failover reuses the same translation.
  let translated: Json | null = null;
  const dialled = async (candidate: ModelRow): Promise<Response> => {
    if (translated === null) translated = anthropicToOpenAI(body, candidate.id);
    else translated = { ...translated, model: candidate.id };
    return fetch(gatewayCompletionsUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
      body: JSON.stringify(upstreamBody(translated, candidate.id)),
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
    });
  };
  const failures: TrailRow[] = [];
  let served: { res: Response; model: string } | null = null;
  for (const candidate of candidates.slice(0, MAX_ATTEMPTS_PER_PROMPT)) {
    let upstream: Response;
    try {
      upstream = await dialled(candidate);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      failures.push({ status: timedOut ? 504 : 502, code: timedOut ? 'timeout' : 'upstream_unreachable', model: candidate.id });
      noteRefusal(candidate.id);
      continue;
    }
    if (upstream.ok) {
      served = { res: upstream, model: candidate.id };
      break;
    }
    const text = await upstream.text().catch(() => '');
    failures.push({ status: upstream.status, code: failureCode(upstream.status, text), model: candidate.id });
    noteRefusal(candidate.id);
  }
  if (served === null) {
    return sendError(res, 'anthropic', 502, 'api_error', 'every free model that meets this request refused it', failures);
  }
  const { res: upstream, model } = served;
  if (upstream.body === null) return sendError(res, 'anthropic', 502, 'api_error', 'the gateway answered with no body', failures);
  const trail = trailValue(failures);
  if (body.stream === true) {
    const headers: Record<string, string> = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };
    if (trail !== null) headers['x-makefun-upstream-failures'] = trail;
    res.writeHead(200, headers);
    try {
      for await (const event of translateAnthropicStream(upstream.body, model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json().catch(() => null);
  if (!isObj(answer)) return sendError(res, 'anthropic', 502, 'api_error', 'the gateway answer is not one JSON object', failures);
  sendJson(res, 200, openAIToAnthropic(answer, model), failures);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    modelsRoute(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chatRoute(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messagesRoute(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Register, poll, start
// ---------------------------------------------------------------------------

function listenOn(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isObj(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

function pollWork(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isObj(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_MS);
}

async function start(): Promise<void> {
  if (brief.problem !== null) log(brief.problem);
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (gatewayCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listenOn(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${listModels().length} free models`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  pollWork(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
