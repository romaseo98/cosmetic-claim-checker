// FDA Cosmetics Claim Checker — backend with PASSWORD + CREDIT system (Vercel + Upstash Redis).
//
// Flow: customer pays you on Kmong -> you issue a password and set its credit balance ->
// customer enters the password in the tool -> each analysis deducts 1 credit -> 0 = blocked.
//
// Required env vars (Vercel -> Project -> Settings -> Environment Variables):
//   ANTHROPIC_API_KEY          your Anthropic key (billed to you)
//   UPSTASH_REDIS_REST_URL     from Upstash (REST API section)
//   UPSTASH_REDIS_REST_TOKEN   from Upstash (REST API section)
//   ADMIN_TOKEN                a secret you choose, used to top up credits via /api/analyze?admin=...
//
// Credit accounting:
//   - Each customer password is a Redis key:  credit:<password>  whose value is the remaining count.
//   - 1 analysis = 1 credit. A long detail page is split into chunks by the frontend, but only the
//     FIRST chunk of a new analysis charges a credit (the frontend sends charge:true once per run).

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;
const MAX_IMAGES = 4;
const MAX_BYTES = 4 * 1024 * 1024;

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// --- tiny Upstash REST helper ---
async function redis(command) {
  // command is an array, e.g. ["GET","credit:abc"] or ["DECR","credit:abc"]
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const data = await r.json();
  return data.result;
}

const SYSTEM_PROMPT =
`You are an FDA cosmetics labeling & marketing-claims compliance expert. You receive 1-3 images that are vertical slices of ONE continuous Korean e-commerce cosmetics detail page (상세페이지), ordered top to bottom (or a single normal product/packaging image). Read them as one continuous section. Find marketing claims that may violate US FDA regulations and propose compliant rewrites that keep marketing appeal. Ignore duplicated text in overlapping regions between slices.

FRAMEWORK (FD&C Act): A COSMETIC only cleanses/beautifies/alters appearance WITHOUT affecting body structure or function. A DRUG treats/cures/prevents disease OR affects structure/function. Intended use is judged by the CLAIMS. A cosmetic making drug claims = illegal unapproved new drug.

HIGH RISK (drug/disease claims): treats/cures/prevents/heals any condition (acne, eczema, rosacea, dermatitis); 'recovery/회복/리커버리', 'regeneration/재생', 'repair'; anti-inflammatory; 'soothes/calms inflammation (진정 medical)'; stimulates/boosts collagen or elastin; rebuilds/restores skin or cells; cell renewal/turnover; increases elasticity; penetrates the dermis; 'for problematic/troubled skin (문제성 피부)' framed as treating it; pain/bruise/swelling relief (relevant to arnica/아르니카); detox; reduces inflammation.

HIGH RISK (false/prohibited): 'FDA approved/certified/registered' (cosmetics are NOT FDA-approved; MoCRA facility registration is NOT product approval); 'chemical-free'.

MEDIUM RISK (allowed only with substantiation): 'safe / 안전 / 유해성분 무 / 무해' as a safety guarantee; 'hypoallergenic', 'non-comedogenic'; 'dermatologist tested/recommended'; 'clinically/perception tested (지각테스트), clinically proven'; 'patented (특허)' implying efficacy; 'natural / 100% natural / organic'; 'non-toxic', 'clean'; comparative/superlative ('#1','best').

CONTEXT-DEPENDENT: 'anti-aging','reduces wrinkles','firms','lifts','brightening/whitening','soothing/진정','calming' — DRUG claims if framed as changing skin biology or treating a condition; OK as COSMETIC claims when reframed around APPEARANCE/FEEL.

SPF/sun protection -> makes it an OTC drug (sunscreen monograph). K-BEAUTY GAP: Korea's 기능성화장품 may claim 미백/주름개선/자외선차단; in the US these often become DRUG claims — note the gap and give a US-compliant alternative.

REWRITE TECHNIQUE: turn structure/function language into appearance/feel language using 'the appearance of / the look of / leaves skin feeling / visibly / for ___-prone skin'. Examples: '리커버리/recovery' -> 'comforting, for a refreshed-looking complexion'; '재생' -> 'for a renewed-looking, smoother appearance'; '진정/soothes inflammation' -> 'helps soothe the look of redness'; '문제성 피부' -> 'for blemish-prone or sensitive-feeling skin'; '미백/whitening' -> 'brightens the look of skin / evens the appearance of tone'; '무해/safe' -> drop the guarantee, describe formulation factually. Keep claims truthful; FTC also requires substantiation.

OUTPUT: Return ONLY valid JSON (no markdown, no backticks, no preamble), EXACTLY:
{"claims":[{"original":string,"risk":"high|medium|low|ok","category_ko":string,"category_en":string,"issue_ko":string,"issue_en":string,"fda_basis_ko":string,"fda_basis_en":string,"suggestion_ko":string,"suggestion_en":string}],"tips_ko":[string],"tips_en":[string]}
Provide BOTH Korean and English for every field. Keep each field to one short sentence (under ~14 words). Return at most 6 claims (most important first) and at most 3 tips. If this section has no problematic claims, return {"claims":[],"tips_ko":[],"tips_en":[]}.`;

module.exports = async function handler(req, res) {
  // ---- ADMIN: top up / check credits ----
  // GET  /api/analyze?admin=ADMIN_TOKEN&pw=roma-0001            -> { password, credits }
  // GET  /api/analyze?admin=ADMIN_TOKEN&pw=roma-0001&set=50     -> set balance to 50
  // GET  /api/analyze?admin=ADMIN_TOKEN&pw=roma-0001&add=20     -> add 20 to balance
  if (req.method === "GET") {
    const q = req.query || {};
    if (!q.admin || q.admin !== process.env.ADMIN_TOKEN) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!q.pw) { res.status(400).json({ error: "missing pw" }); return; }
    try {
      const k = "credit:" + q.pw;
      if (q.set != null) { await redis(["SET", k, String(parseInt(q.set, 10) || 0)]); }
      else if (q.add != null) { await redis(["INCRBY", k, String(parseInt(q.add, 10) || 0)]); }
      const bal = await redis(["GET", k]);
      res.status(200).json({ password: q.pw, credits: bal == null ? 0 : parseInt(bal, 10) });
    } catch (e) { res.status(500).json({ error: "admin error" }); }
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "Server not configured" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const content = body && body.content;
  const password = (body && body.password ? String(body.password) : "").trim();
  const charge = !!(body && body.charge); // true only on the first chunk of an analysis

  if (!password) { res.status(401).json({ error: "no_password" }); return; }
  if (!Array.isArray(content)) { res.status(400).json({ error: "Bad request" }); return; }
  if (content.filter(function (c) { return c && c.type === "image"; }).length > MAX_IMAGES) { res.status(413).json({ error: "Too many images" }); return; }
  if (JSON.stringify(content).length > MAX_BYTES) { res.status(413).json({ error: "Payload too large" }); return; }

  // ---- credit check ----
  let balance;
  try {
    const raw = await redis(["GET", "credit:" + password]);
    if (raw == null) { res.status(403).json({ error: "invalid_password" }); return; }
    balance = parseInt(raw, 10) || 0;
  } catch (e) { res.status(500).json({ error: "credit check failed" }); return; }

  if (charge && balance <= 0) { res.status(402).json({ error: "no_credits", credits: 0 }); return; }

  // ---- call Anthropic ----
  let text;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: "user", content: content }] })
    });
    if (!r.ok) { const d = await r.text().catch(function () { return ""; }); res.status(502).json({ error: "Upstream error " + r.status, detail: d.slice(0, 300) }); return; }
    const data = await r.json();
    text = (data.content || []).map(function (b) { return b.type === "text" ? b.text : ""; }).join("");
  } catch (e) { res.status(500).json({ error: "Server error" }); return; }

  // ---- deduct 1 credit, only once per analysis (the charging chunk) and only on success ----
  let creditsLeft = balance;
  if (charge) {
    try { creditsLeft = await redis(["DECR", "credit:" + password]); } catch (e) { /* answer already produced; ignore */ }
  }

  res.status(200).json({ text: text, credits: creditsLeft });
};
