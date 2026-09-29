// Asks Claude to answer a page's form fields using only the resume + profile.

const Anthropic = require("@anthropic-ai/sdk");
const { z } = require("zod");
const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");

const MODEL = process.env.JAB_MODEL || "claude-opus-5-5";

const AnswerSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      value: z.string().nullable(),
      selections: z.array(z.string()),
      source: z.enum(["profile", "resume", "tailored", "unknown"]),
      needs_review: z.boolean(),
      note: z.string(),
    }),
  ),
});

const SYSTEM = `You fill out job applications on behalf of the candidate described below. For each form field you are given, produce the answer the candidate would give.

How to answer:
- Every factual claim must be supported by the RESUME or PROFILE. Never invent employers, titles, dates, degrees, certifications, skills, years of experience, metrics, or links. If the information isn't there, set value to null, source "unknown", needs_review true, and say in the note what's missing.
- Contact details, work authorization, sponsorship, salary, start date, relocation, and demographic/EEO/veteran/disability questions come from PROFILE only. For voluntary demographic questions not covered by PROFILE, pick the "decline to answer"-style option if one exists, otherwise leave null.
- If PROFILE.customAnswers has an entry that matches a question, use it.
- Free-text questions (why this company, describe a project, cover letter, etc.): write in the candidate's first-person voice, grounded in real resume content, tailored to the JOB POSTING. Be specific and concise; no clichés, no flattery, no claims beyond the resume. Respect maxLength if given. Use source "tailored" and set needs_review true so the candidate reads it before submitting.
- Yes/no questions about a skill or experience: answer "Yes" only if the resume clearly supports it; if it's borderline, answer honestly and flag needs_review.

Field kinds and what to return:
- text/email/tel/url/number/textarea/date/combobox: put the answer in value (date as YYYY-MM-DD); selections [].
- select and radio: value must be copied exactly from the field's options; selections [].
- checkbox (multiple options): selections lists the exact option texts to tick; value null.
- single_checkbox: value "true" to tick it or "false" to leave it; selections [].
- file: value null, selections [] (uploads are handled separately).
Return exactly one answer per field id you were given. The note is a short reason (under 20 words).`;

let client;

async function answerFields({ fields, jobText, url, profile, resumeText }) {
  client ??= new Anthropic();
  const askable = fields.filter((f) => f.kind !== "file");
  if (!askable.length) return [];

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(AnswerSchema) },
    // Resume + profile are identical on every page, so cache them.
    system: [
      { type: "text", text: SYSTEM },
      {
        type: "text",
        text: `RESUME:\n${resumeText}\n\nPROFILE:\n${JSON.stringify(profile, null, 2)}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `JOB POSTING (${url}):\n${jobText}\n\nFORM FIELDS:\n${JSON.stringify(askable, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined to answer this form.");
  if (response.stop_reason === "max_tokens") throw new Error("Answer generation was cut off (max_tokens).");
  if (!response.parsed_output) throw new Error("Claude's response didn't match the expected answer format.");

  const byId = new Map(response.parsed_output.answers.map((a) => [a.id, a]));
  return askable.map(
    (f) => byId.get(f.id) ?? { id: f.id, value: null, selections: [], source: "unknown", needs_review: true, note: "No answer returned." },
  );
}

module.exports = { answerFields };
