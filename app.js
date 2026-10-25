// ClearBill: one page, three views (#, #results, #settings). No server: the
// browser talks to Google's Gemini API with the user's own key, and everything
// is kept in sessionStorage, so it vanishes when the tab closes.
import { ANALYSIS_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, SAMPLE_ANALYSIS, SAMPLE_BILL } from "./data.js";

/* ---------- storage ---------- */

const S = sessionStorage;
const read = (key, fallback) => {
  try {
    return JSON.parse(S.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => S.setItem(key, JSON.stringify(value));

const DEFAULT_MODEL = "gemini-flash-lite-latest";
const apiKey = () => S.getItem("apiKey") ?? "";
const model = () => S.getItem("model") ?? DEFAULT_MODEL;

const history = () => read("history", []);
const current = () => read("current", null);

// Saves a scan and opens it. A fixed id (the sample bill) replaces any earlier copy.
function saveScan(extraction, analysis, id = crypto.randomUUID()) {
  const scan = { id, extraction, analysis, answers: {}, appliedAnswers: {} };
  write("history", [scan, ...history().filter((s) => s.id !== id)]);
  write("current", scan);
}

// Changes the open scan, and its copy in the history list.
function patchCurrent(patch) {
  const scan = { ...current(), ...patch };
  write("current", scan);
  write("history", history().map((s) => (s.id === scan.id ? scan : s)));
}

/* ---------- small helpers ---------- */

// h("div", { class: "card" }, "text", h("b", {}, "more")) builds an element.
// Text is always inserted as text, never HTML, so nothing read from a bill or
// returned by the AI can inject markup into the page.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === false || value == null) continue;
    if (name.startsWith("on")) el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}
const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : String(c))));

const money = (n) => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const errorText = (e) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");
const errorLine = (message) =>
  message && h("p", { class: "err" }, message, " ", message.includes("Settings") && !apiKey() && h("a", { href: "#settings" }, "Go to Settings"));

/* ---------- Gemini ---------- */

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function gemini(path, init) {
  const res = await fetch(`${GEMINI}/${path}`, { ...init, headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey(), ...init?.headers } });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  throw new GeminiError(res.status, body?.error?.message ?? "");
}

// One generateContent call returning the model's JSON text ("" if it returned nothing).
async function generateJson(systemPrompt, parts) {
  const data = await gemini(`models/${encodeURIComponent(model())}:generateContent`, {
    method: "POST",
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  return (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

// Text-in/text-out Gemini models only: no embeddings, image/audio, live, etc.
async function listModels() {
  const excluded = /tts|image|live|audio|embed|robotics|computer-use|veo|imagen/i;
  const data = await gemini("models?pageSize=1000");
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /^models\/gemini-/.test(m.name) && !excluded.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name.replace(/^models\//, "") }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

// Maps Google API failures to messages a stressed user can act on.
function describeApiError(e) {
  const s = e.status;
  if (!(e instanceof GeminiError)) return "Couldn't reach Google's Gemini API. Check your connection and try again.";
  if (s === 401 || s === 403 || /api key/i.test(e.message)) return "Google rejected that API key. Check it in Settings and try again.";
  if (s === 429) return "You've hit Google's free-tier limit for this model for now. Wait a minute and try again, or pick a different model in Settings.";
  if (s === 404) return "Google doesn't recognize that model. Pick a different one in Settings.";
  if (s === 500 || s === 503) return "Google's servers are overloaded right now. Wait a moment and try again, or pick a different model in Settings.";
  return "Something went wrong reading this bill. Please try again.";
}

/* ---------- validating what the AI sends back ---------- */
// Small slips are repaired or dropped rather than throwing away a good answer.

const DOC_TYPES = ["itemized_bill", "summary_bill", "eob", "unknown"];
const CODE_TYPES = ["CPT", "HCPCS", "ICD10", "REV", "NDC", "unknown"];
const LEVELS = ["high", "medium", "low"];
const RULE_LABELS = {
  duplicate_charges: "Possible duplicate charge",
  unbundling: "Possible unbundled charges",
  upcoding: "Possible upcoding",
  quantity_anomaly: "Unusual quantity",
  date_error: "Date problem",
  non_itemized_line: "Vague charge",
  routine_supplies_billed_separately: "Routine supplies billed separately",
  no_surprises_act: "Possible No Surprises Act issue",
  preventive_billed_as_diagnostic: "Preventive care billed as diagnostic",
  facility_fee_on_routine_visit: "Facility fee on a routine visit",
  math_error: "Numbers don't add up",
  services_not_received: "Possible service not received",
};
const RULE_IDS = Object.keys(RULE_LABELS);

// Each helper returns the cleaned value or throws the field path.
const bad = (path) => {
  throw new Error(path);
};
const str = (v, p) => (typeof v === "string" ? v : bad(p));
const strOrNull = (v, p) => (v == null ? null : str(v, p));
const numOrNull = (v, p) => (v == null ? null : Number.isFinite(v) ? v : bad(p));
const oneOf = (v, list, p) => (list.includes(v) ? v : bad(p));
const obj = (v, p) => (v && typeof v === "object" && !Array.isArray(v) ? v : bad(p));
const arr = (v, p) => (Array.isArray(v) ? v : bad(p));
const pick = (o, prefix, fn, keys) => Object.fromEntries(keys.map((k) => [k, fn(o[k], prefix + k)]));

function validateExtraction(raw) {
  const o = obj(raw, "root");
  return {
    documentType: oneOf(o.documentType, DOC_TYPES, "documentType"),
    provider: pick(obj(o.provider ?? {}, "provider"), "provider.", strOrNull, ["name", "address", "billingPhone"]),
    ...pick(o, "", strOrNull, ["accountNumber", "claimNumber"]),
    serviceDates: pick(obj(o.serviceDates ?? {}, "serviceDates"), "serviceDates.", strOrNull, ["start", "end"]),
    lineItems: arr(o.lineItems, "lineItems").map((li, i) => {
      const p = `lineItems.${i}.`;
      const item = obj(li, p);
      return {
        id: String(item.id ?? i + 1),
        ...pick(item, p, strOrNull, ["date"]),
        description: str(item.description, p + "description"),
        code: strOrNull(item.code == null ? null : String(item.code), p + "code"),
        codeType: oneOf(item.codeType ?? "unknown", CODE_TYPES, p + "codeType"),
        ...pick(item, p, numOrNull, ["quantity", "unitCharge", "totalCharge"]),
      };
    }),
    totals: pick(obj(o.totals ?? {}, "totals"), "totals.", numOrNull, ["totalCharges", "insurancePaid", "adjustments", "patientResponsibility"]),
    insurance: pick(obj(o.insurance ?? {}, "insurance"), "insurance.", strOrNull, ["payerName", "planName"]),
    legibilityNotes: arr(o.legibilityNotes ?? [], "legibilityNotes").map(String),
  };
}

function validateAnalysis(raw) {
  const o = obj(raw, "root");
  return {
    lineExplanations: arr(o.lineExplanations, "lineExplanations").map((e, i) => ({
      lineItemId: String(obj(e, `lineExplanations.${i}`).lineItemId),
      explanation: str(e.explanation, `lineExplanations.${i}.explanation`),
    })),
    // Flags with an invented rule id are dropped instead of failing everything.
    flags: arr(o.flags, "flags")
      .filter((f) => f && RULE_IDS.includes(f.ruleId))
      .map((f, i) => {
        const p = `flags.${i}.`;
        return {
          ruleId: f.ruleId,
          severity: oneOf(f.severity, LEVELS, p + "severity"),
          confidence: oneOf(f.confidence, LEVELS, p + "confidence"),
          affectedLineItemIds: arr(f.affectedLineItemIds ?? [], p + "affectedLineItemIds").map(String),
          estimatedAmountAtStake: typeof f.estimatedAmountAtStake === "number" ? f.estimatedAmountAtStake : null,
          plainExplanation: str(f.plainExplanation, p + "plainExplanation"),
          whatToAsk: str(f.whatToAsk, p + "whatToAsk"),
        };
      }),
    followUpQuestions: arr(o.followUpQuestions, "followUpQuestions").map((q, i) => ({
      id: String(obj(q, `followUpQuestions.${i}`).id ?? `q${i + 1}`),
      question: str(q.question, `followUpQuestions.${i}.question`),
      relatedRuleIds: arr(q.relatedRuleIds ?? [], `followUpQuestions.${i}.relatedRuleIds`).filter((id) => RULE_IDS.includes(id)),
    })),
  };
}

function parse(raw, validate) {
  try {
    return validate(JSON.parse(raw));
  } catch (e) {
    // Field names only, never the bill contents.
    console.error("model output rejected:", e.message);
    return null;
  }
}

/* ---------- bill arithmetic ---------- */
// Done in code rather than trusted to the model: the model reads the numbers,
// this checks that they add up.

const round = (n) => Math.round(n * 100) / 100;
const sum = (nums) => nums.reduce((a, b) => a + b, 0);

function mathFlag(diff, confidence, plainExplanation, whatToAsk) {
  return { ruleId: "math_error", severity: diff >= 50 ? "high" : "medium", confidence, affectedLineItemIds: [], estimatedAmountAtStake: diff, plainExplanation, whatToAsk };
}

function computeMathFlags(extraction) {
  if (extraction.documentType !== "itemized_bill") return [];
  const flags = [];
  const { totalCharges, insurancePaid, adjustments, patientResponsibility } = extraction.totals;

  if ([totalCharges, insurancePaid, adjustments, patientResponsibility].every((n) => n !== null)) {
    // Bills print payments/adjustments as either positive or negative.
    const paid = Math.abs(insurancePaid);
    const adj = Math.abs(adjustments);
    const expected = round(totalCharges - paid - adj);
    const diff = round(Math.abs(patientResponsibility - expected));
    if (diff >= 0.01) {
      flags.push(
        mathFlag(
          diff,
          "high",
          `The numbers on this bill don't add up. Total charges (${money(totalCharges)}) minus insurance paid (${money(paid)}) minus adjustments (${money(adj)}) comes to ${money(expected)}, but the bill says you owe ${money(patientResponsibility)} — a ${money(diff)} difference.`,
          `Can you walk me through how ${money(patientResponsibility)} was calculated from ${money(totalCharges)} in charges, ${money(paid)} paid by insurance, and ${money(adj)} in adjustments? My math comes to ${money(expected)}.`
        )
      );
    }
  }

  const lineTotals = extraction.lineItems.map((i) => i.totalCharge);
  if (totalCharges !== null && lineTotals.length > 0 && lineTotals.every((t) => t !== null)) {
    const total = round(sum(lineTotals));
    const diff = round(Math.abs(total - totalCharges));
    if (diff >= 0.01) {
      flags.push(
        mathFlag(
          diff,
          "medium",
          `The individual charges on this bill add up to ${money(total)}, but the stated total charges are ${money(totalCharges)} — a ${money(diff)} difference. (If a page of the bill is missing from your upload, that could explain it.)`,
          `The line items I can see add up to ${money(total)}, but the total says ${money(totalCharges)}. Can you explain the difference or send a complete itemized bill?`
        )
      );
    }
  }
  return flags;
}

// Dollar amounts the model tends to add up wrongly are recomputed from the line
// items the flag points at. These are upper bounds, not savings estimates.
function fixAmount(extraction, flag) {
  const items = flag.affectedLineItemIds.map((id) => extraction.lineItems.find((i) => i.id === id));
  if (items.length === 0 || items.some((i) => !i || i.totalCharge === null)) return flag;
  const charges = items.map((i) => i.totalCharge);
  // For duplicates the first charge is the legitimate one; the repeats are in question.
  const counted = { unbundling: charges, non_itemized_line: charges, routine_supplies_billed_separately: charges, duplicate_charges: charges.slice(1) }[flag.ruleId];
  return counted ? { ...flag, estimatedAmountAtStake: round(sum(counted)) } : flag;
}

/* ---------- the two AI jobs ---------- */
// Both throw an Error whose message is safe to show the user.

const RETRY_NOTE = "Your previous response did not match the required JSON schema exactly. Return ONLY a valid JSON object matching the schema, with no extra text.";

// Asks, validates, and retries once if the answer has the wrong shape.
async function ask(systemPrompt, buildParts, validate, failure) {
  try {
    for (const note of [null, RETRY_NOTE]) {
      const result = parse(await generateJson(systemPrompt, buildParts(note)), validate);
      if (result) return result;
    }
  } catch (e) {
    throw new Error(describeApiError(e));
  }
  throw new Error(failure);
}

// Phone photos are often 4000+ px; bill text stays readable at 2400px and
// smaller uploads are faster. PDFs and formats the browser can't decode pass through.
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_000_000) return file;
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return !blob || blob.size >= file.size ? file : new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function fileToPart(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Chunked: spreading a whole file into one call overflows the stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { inline_data: { mime_type: file.type, data: btoa(binary) } };
}

// Gemini reads these natively, PDFs included.
const SUPPORTED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

async function readBill(files) {
  for (const file of files) {
    if (!SUPPORTED_TYPES.includes(file.type)) throw new Error(`"${file.name}" isn't a supported file type. Upload a JPEG, PNG, WEBP, HEIC, or PDF.`);
  }
  const fileParts = await Promise.all(files.map(fileToPart));
  return ask(
    EXTRACTION_SYSTEM_PROMPT,
    (note) => [{ text: "Transcribe this medical bill into the required JSON schema." + (note ? ` ${note}` : "") }, ...fileParts],
    validateExtraction,
    "We couldn't read this bill clearly. Try a clearer photo, a different file, or a different model in Settings."
  );
}

// answered: [{ question, answer }] from earlier rounds.
async function analyzeBill(extraction, answered) {
  let text = `Here is the extracted bill data:\n\n${JSON.stringify(extraction)}`;
  if (answered.length > 0) text += `\n\nThe patient has answered these follow-up questions from a previous round:\n\n${JSON.stringify(answered)}`;
  const result = await ask(ANALYSIS_SYSTEM_PROMPT, (note) => [{ text: note ? `${text}\n\n${note}` : text }], validateAnalysis, "We couldn't analyze this bill. Try again, or a different model in Settings.");
  // Math flags from the model are replaced by the computed ones.
  return { ...result, flags: [...result.flags.filter((f) => f.ruleId !== "math_error").map((f) => fixAmount(extraction, f)), ...computeMathFlags(extraction)] };
}

/* ---------- comparing analysis rounds ---------- */

// Flags are matched by rule (in order, when a rule repeats). The model often
// lists slightly different line items for the same concern between runs, so
// comparing line items would report phantom changes.
function diffFlags(before, after) {
  const pool = new Map();
  for (const f of before) pool.set(f.ruleId, [...(pool.get(f.ruleId) ?? []), f]);
  const added = [];
  const updated = [];
  for (const f of after) {
    const match = pool.get(f.ruleId)?.shift();
    if (!match) added.push(f);
    else if (match.severity !== f.severity || match.confidence !== f.confidence) updated.push(f);
  }
  return { added, updated, removed: [...pool.values()].flat() };
}

// True when two follow-up questions are mostly the same question reworded.
function similarQuestions(a, b) {
  const words = (q) => new Set(q.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  return [...wa].filter((w) => wb.has(w)).length / Math.min(wa.size, wb.size) >= 0.5;
}

/* ---------- views ---------- */
// A view is called with paint(...children), which replaces the page contents
// unless the user has already navigated elsewhere.

const main = document.getElementById("main");
let navigation = 0;

function home(paint) {
  const MAX_TOTAL_BYTES = 14_000_000; // Gemini allows ~20 MB per request; files grow ~33% when encoded
  let files = [];
  let phase = "idle"; // idle | preparing | extracting | analyzing | error
  let error = null;
  const busy = () => ["preparing", "extracting", "analyzing"].includes(phase);
  const set = (next, message = null) => {
    phase = next;
    error = message;
    drawUploader();
  };

  const input = h("input", {
    type: "file",
    accept: "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf",
    multiple: true,
    hidden: true,
    onchange: async () => {
      const picked = [...input.files];
      input.value = ""; // lets the same file be picked again
      if (picked.length === 0) return;
      set("preparing");
      const next = [...files, ...(await Promise.all(picked.map(shrinkImage)))];
      const bytes = sum(next.map((f) => f.size));
      if (bytes > MAX_TOTAL_BYTES) return set("error", `Those files add up to ${(bytes / 1e6).toFixed(1)} MB, which is over the ${MAX_TOTAL_BYTES / 1e6} MB limit. Try fewer pages, or a smaller PDF.`);
      files = next;
      set("idle");
    },
  });

  async function submit() {
    if (!apiKey()) return set("error", "Add your Google AI Studio key in Settings first.");
    set("extracting");
    try {
      const extraction = await readBill(files);
      set("analyzing");
      saveScan(extraction, await analyzeBill(extraction, []));
      location.hash = "#results";
    } catch (e) {
      set("error", errorText(e));
    }
  }

  const uploader = h("div", { class: "stack" });
  function drawUploader() {
    const progress = { preparing: "Preparing your files…", extracting: "Step 1 of 2 — reading your bill…", analyzing: "Step 2 of 2 — understanding your charges…" }[phase];
    fill(uploader,
      h("button", { class: "wide", disabled: busy(), onclick: () => input.click() }, files.length === 0 ? "Upload a photo or PDF" : "Add another page"),
      files.length > 0 &&
        h("ul", { class: "list" }, files.map((file, i) =>
          h("li", { class: "row" }, file.name, h("span", { class: "muted" }, `${(file.size / 1e6).toFixed(1)} MB `, !busy() && h("button", { class: "link", "aria-label": `Remove ${file.name}`, onclick: () => { files.splice(i, 1); set("idle"); } }, "×")))
        )),
      files.length > 0 && !busy() && h("button", { class: "wide primary", onclick: submit }, "Analyze this bill"),
      busy() && h("p", { class: "muted", "aria-live": "polite" }, h("span", { class: "spin" }), progress),
      phase === "error" && errorLine(error)
    );
  }

  const saved = h("section", { class: "stack" });
  function drawSaved() {
    const scans = history();
    saved.hidden = scans.length === 0;
    const forget = (list) => { write("history", list); drawSaved(); };
    fill(saved,
      h("div", { class: "row" }, h("h2", {}, "Previous scans"), h("button", { class: "link", onclick: () => { S.removeItem("history"); drawSaved(); } }, "Clear all")),
      h("p", { class: "muted" }, "Kept only in this browser tab — they disappear when you close it."),
      h("ul", { class: "list" }, scans.map(({ id, extraction: x, analysis }) =>
        h("li", { class: "card row" },
          h("button", { class: "link", onclick: () => { write("current", history().find((s) => s.id === id)); location.hash = "#results"; } },
            h("b", {}, (x.provider.name ?? "Unknown provider") + (id === "sample" ? " (sample)" : "")), h("br"),
            h("small", {}, `${x.serviceDates.start ?? "Date unknown"} · ${analysis.flags.length} flag${analysis.flags.length === 1 ? "" : "s"} · ${money(x.totals.patientResponsibility)}`)),
          h("button", { class: "link", "aria-label": "Remove this scan", onclick: () => forget(history().filter((s) => s.id !== id)) }, "×")
        )
      ))
    );
  }

  paint(
    h("div", {}, h("h1", {}, "ClearBill"), h("p", { class: "muted" }, "Medical bills are deliberately hard to read. Upload yours and get a plain-English explanation of every charge, plus the ones worth questioning.")),
    h("div", { class: "stack" }, input, uploader, h("button", { class: "wide primary", onclick: () => { saveScan(SAMPLE_BILL, SAMPLE_ANALYSIS, "sample"); location.hash = "#results"; } }, "Try a sample bill")),
    saved,
    h("p", { class: "muted" }, "ClearBill never stores your files. Nothing is saved beyond this browser tab. A real bill is sent to Google's Gemini API to be read, and on Google's free tier that content can be used to improve its products. Try the sample bill first, or use your own ", h("a", { href: "#settings" }, "Google AI Studio key"), ".")
  );
  drawUploader();
  drawSaved();
}

function results(paint) {
  const scan = current();
  if (!scan) {
    return paint(h("h1", {}, "No bill is open"), h("p", { class: "muted" }, "Upload a bill, or try the sample, to see results here."), h("a", { href: "#" }, "Go to the home page"));
  }
  const { extraction } = scan;
  let { analysis, answers, appliedAnswers: applied } = scan;
  let changes = null;
  let rechecking = false;
  let recheckError = null;

  const LEVEL_LABEL = { high: "High priority", medium: "Worth a question", low: "Minor" };
  const answersKey = (a) => JSON.stringify(Object.entries(a).sort());

  async function recheck() {
    if (!apiKey()) {
      recheckError = "Add your Google AI Studio key in Settings first.";
      return render();
    }
    rechecking = true;
    recheckError = null;
    render();
    const answered = analysis.followUpQuestions.filter((q) => answers[q.id]);
    try {
      const data = await analyzeBill(extraction, answered.map((q) => ({ question: q.question, answer: answers[q.id] })));
      // Keep the questions already answered; add only genuinely new ones. The
      // model restarts ids at q1 each run, so prefix them to avoid collisions.
      const round = Date.now().toString(36);
      const seen = answered.map((q) => q.question);
      const fresh = data.followUpQuestions
        .filter((q) => !seen.some((s) => similarQuestions(s, q.question)) && seen.push(q.question))
        .map((q) => ({ ...q, id: `${round}-${q.id}` }));
      const next = { lineExplanations: data.lineExplanations, flags: data.flags, followUpQuestions: [...answered, ...fresh] };
      changes = diffFlags(analysis.flags, next.flags);
      analysis = next;
      applied = { ...answers };
      patchCurrent({ analysis, answers, appliedAnswers: answers });
    } catch (e) {
      recheckError = errorText(e);
    }
    rechecking = false;
    render();
  }

  const stat = (label, value, strong) => h("div", {}, h("small", {}, label), h(strong ? "b" : "p", {}, money(value)));

  const flagCard = (flag) => {
    const badge = changes?.added.includes(flag) ? "New" : changes?.updated.includes(flag) ? "Updated" : null;
    return h("div", { class: `flag ${flag.severity}` },
      h("div", { class: "row" },
        h("strong", {}, LEVEL_LABEL[flag.severity], badge && h("span", { class: "badge" }, badge)),
        flag.estimatedAmountAtStake !== null && h("b", {}, `${money(flag.estimatedAmountAtStake)} at stake`)
      ),
      h("p", {}, flag.plainExplanation),
      h("div", { class: "card" }, h("small", {}, "WHAT TO ASK"), h("p", {}, flag.whatToAsk)),
      h("small", {}, `Confidence: ${flag.confidence}`)
    );
  };

  function changesBanner() {
    const { added, updated, removed } = changes;
    const item = (label, f, extra = "") => h("li", {}, h("strong", {}, label), ` ${RULE_LABELS[f.ruleId]}${extra}`);
    return h("section", { class: "card" },
      h("b", {}, "What changed after your answers"),
      added.length + updated.length + removed.length === 0
        ? h("p", { class: "muted" }, "Your answers didn't change any of the flags.")
        : h("ul", {}, added.map((f) => item("New:", f)), updated.map((f) => item("Updated:", f, ` (now ${f.severity} priority, ${f.confidence} confidence)`)), removed.map((f) => item("No longer flagged:", f)))
    );
  }

  const questionCard = (q) =>
    h("div", { class: "card" },
      h("p", {}, q.question),
      h("div", { class: "row" }, [["yes", "Yes"], ["no", "No"], ["not_sure", "Not sure"]].map(([value, label]) =>
        h("button", { class: answers[q.id] === value ? "primary" : "", onclick: () => { answers = { ...answers, [q.id]: value }; patchCurrent({ answers }); render(); } }, label)
      ))
    );

  const lineRow = (item) => {
    const explanation = analysis.lineExplanations.find((e) => e.lineItemId === item.id)?.explanation;
    const meta = [item.date ?? "Date unclear", item.code && `${item.codeType} ${item.code}`, item.quantity !== null && item.quantity !== 1 && `Qty ${item.quantity}`].filter(Boolean).join(" · ");
    return h("div", {},
      h("div", { class: "row" }, h("div", {}, h("b", {}, item.description), h("p", { class: "muted" }, meta)), h("b", {}, money(item.totalCharge))),
      explanation && h("p", {}, explanation)
    );
  };

  function render() {
    const t = extraction.totals;
    if (extraction.documentType === "unknown" && extraction.lineItems.length === 0 && t.totalCharges === null && t.patientResponsibility === null) {
      return paint(
        h("h1", {}, "This doesn't look like a medical bill"),
        h("p", { class: "muted" }, "ClearBill couldn't find charges or totals in what you uploaded. Try a clearer, well-lit photo of the whole page, or upload the PDF if you have one."),
        h("a", { href: "#" }, "Try another file")
      );
    }
    if (extraction.documentType === "summary_bill") {
      const phone = extraction.provider.billingPhone;
      return paint(
        h("h1", {}, "This looks like a summary bill"),
        h("p", {}, "This document only shows a total amount due, without a breakdown of individual charges, so there's nothing here to check yet. You can ask the provider for an itemized bill, and they should provide one on request."),
        h("div", { class: "card" },
          h("b", {}, "What you could say"),
          h("p", {}, "“I'd like an itemized bill for my account that lists each charge with its date, description, and billing code (CPT or HCPCS). My account number is ______.”"),
          h("p", {}, `Call the billing department${phone ? ` at ${phone}` : " (the number is usually printed on the statement)"}, or send the same request in writing. Once you have the itemized bill, upload it here.`)
        )
      );
    }

    const order = { high: 0, medium: 1, low: 2 };
    const flags = [...analysis.flags].sort((a, b) => order[a.severity] - order[b.severity]);
    const questions = analysis.followUpQuestions;
    const analyzed = analysis.lineExplanations.length > 0;
    paint(
      h("header", {}, h("h1", {}, extraction.provider.name ?? "Unknown provider"), h("p", { class: "muted" }, extraction.serviceDates.start ?? "Date unknown")),
      extraction.documentType === "eob" && h("p", { class: "card" }, "This looks like an insurance Explanation of Benefits, not a bill from a provider. It's still explained below, but some checks work best on the provider's own itemized bill."),
      h("section", { class: "totals" }, stat("Total charges", t.totalCharges), stat("Insurance paid", t.insurancePaid), stat("Adjustments", t.adjustments), stat("You owe", t.patientResponsibility, true)),
      changes && changesBanner(),
      flags.length > 0 && h("section", { class: "stack" }, h("h2", {}, "Worth asking about"), flags.map(flagCard)),
      questions.length > 0 &&
        h("section", { class: "stack" },
          h("h2", {}, "A few quick questions"),
          h("p", { class: "muted" }, "Your answers can change which flags above still apply."),
          questions.map(questionCard),
          Object.keys(answers).length > 0 && answersKey(answers) !== answersKey(applied) && h("button", { class: "wide primary", disabled: rechecking, onclick: recheck }, rechecking ? "Re-checking your bill…" : "Update flags with my answers"),
          errorLine(recheckError)
        ),
      !analyzed && h("p", { class: "card dashed" }, "This bill hasn't been analyzed yet."),
      analyzed && flags.length === 0 && questions.length === 0 && h("p", { class: "card" }, "Nothing on this bill met the bar for a flag. That's a good sign, not a guarantee — it's still worth a glance at the line items below."),
      h("section", { class: "stack" }, h("h2", {}, "Every line item, explained"), h("div", { class: "lines" }, extraction.lineItems.map(lineRow))),
      extraction.legibilityNotes.length > 0 && h("section", { class: "card" }, h("b", {}, "A note on legibility"), h("ul", {}, extraction.legibilityNotes.map((n) => h("li", {}, n))))
    );
  }
  render();
}

function settings(paint) {
  // The model list needs the user's key, so it loads whenever a key is saved.
  let models = [];
  let status = "idle"; // idle | loading | ready | error
  let loadError = "";
  let saved = false;
  const keyInput = h("input", { id: "apiKey", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "AIza...", value: apiKey() });

  async function loadModels() {
    const key = apiKey();
    status = key ? "loading" : "idle";
    render();
    if (!key) return;
    try {
      models = await listModels();
      status = "ready";
    } catch (e) {
      status = "error";
      loadError = describeApiError(e);
    }
    if (key === apiKey()) render(); // ignore the result if the key changed meanwhile
  }

  function save(e) {
    e.preventDefault();
    const key = keyInput.value.trim();
    key ? S.setItem("apiKey", key) : S.removeItem("apiKey");
    saved = true;
    setTimeout(() => { saved = false; render(); }, 2000);
    loadModels();
  }

  function render() {
    const hasKey = Boolean(apiKey());
    const chosen = model();
    // Keep the stored choice selectable even if it isn't in the fetched list.
    const options = models.some((m) => m.id === chosen) ? models : [{ id: chosen, name: chosen }, ...models];
    paint(
      h("div", { class: "stack" }, h("h1", {}, "Settings"), h("p", { class: "muted" }, "ClearBill doesn't hold an API key of its own. Add a free Google AI Studio key, pick a Gemini model, and you're set.")),
      h("ol", {}, h("li", {}, h("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener noreferrer" }, "Get a free API key at aistudio.google.com/apikey")), h("li", {}, "Paste it below and save."), h("li", {}, "Choose a model.")),
      h("form", { class: "stack", onsubmit: save },
        h("label", { for: "apiKey" }, h("b", {}, "Google AI Studio API key")),
        keyInput,
        h("div", { class: "row" },
          h("button", { class: "primary" }, saved ? "Saved" : "Save"),
          hasKey && h("button", { type: "button", onclick: () => { S.removeItem("apiKey"); keyInput.value = ""; models = []; render(); } }, "Clear key")
        )
      ),
      h("div", { class: "stack" },
        h("label", { for: "model" }, h("b", {}, "Gemini model")),
        h("select", { id: "model", disabled: !hasKey || status === "loading", onchange: (e) => S.setItem("model", e.target.value) }, options.map((m) => h("option", { value: m.id, selected: m.id === chosen }, m.name))),
        !hasKey && h("p", { class: "muted" }, "Save your API key above to load the models available to you."),
        status === "loading" && h("p", { class: "muted" }, "Loading models…"),
        status === "error" && h("p", { class: "err" }, loadError),
        status === "ready" && h("p", { class: "muted" }, "Flash models are the fastest and have the most generous free limits.")
      ),
      h("div", { class: "card" },
        h("p", {}, "Your key and model choice are stored only in this browser tab's session storage and are used only to talk to Google. They never pass through any ClearBill server, and closing this tab clears them."),
        h("p", {}, "Bills you upload go from your browser straight to Google's Gemini API to be read. On Google's free tier, Google may use that content to improve its products. Google advises against submitting personal information to the free tier.")
      ),
      h("a", { href: "#" }, "Back to ClearBill")
    );
  }
  render();
  if (apiKey()) loadModels();
}

/* ---------- shell: header, disclaimer, routing ---------- */

const wipe = h("span", { class: "row" });
const confirmDelete = (asking) =>
  fill(wipe, asking
    ? [h("button", { class: "link", onclick: () => { S.clear(); location.href = location.pathname; } }, "Yes, delete all"), h("button", { class: "link", onclick: () => confirmDelete(false) }, "Cancel")]
    : h("button", { class: "link", onclick: () => confirmDelete(true) }, "Delete everything"));
confirmDelete(false);

// Shown on every screen that displays analysis; deliberately not dismissible.
const disclaimer = h("footer", { class: "disclaimer" }, "This tool provides information, not medical, legal, or financial advice. Verify anything important with your provider or insurer.");
document.body.prepend(h("nav", {}, h("a", { href: "#", class: "brand" }, "ClearBill"), h("a", { href: "#" }, "Home"), h("a", { href: "#settings" }, "Settings"), wipe));
document.body.append(disclaimer);

function route() {
  const id = ++navigation;
  const name = { "#results": "results", "#settings": "settings" }[location.hash] ?? "home";
  main.className = name;
  disclaimer.hidden = name !== "results" || !current();
  window.scrollTo(0, 0);
  ({ home, results, settings })[name]((...children) => id === navigation && fill(main, children));
}
addEventListener("hashchange", route);
route();
